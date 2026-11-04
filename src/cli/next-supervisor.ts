import { fork, type ChildProcess } from 'node:child_process';
import { colors } from '../lib/helpers/color.helper.js';
import {
  SUPERVISOR_READY_MESSAGE,
  SUPERVISOR_SHUTDOWN_MESSAGE,
  type SupervisorMessage,
} from '../lib/process-handlers.js';
import { createConfigWatcher, type ConfigWatcher } from './config-watcher.js';

/**
 * `pp-dev next` runs its server in a process of its own and restarts that process on a config
 * change, as `next dev` restarts its own on a `next.config` change.
 *
 * In one process a restart could never apply a new config: Next.js caches `loadConfig()` for the
 * life of the process (`configCache` in `next/dist/server/config.js`, keyed by directory, phase and
 * pid), so after an edit of `pp-dev.config.*` under a `withPPDev()` layout, or of `next.config.*`,
 * the restarted server got the first config back, backend URL and base path included.
 *
 * The process started by the user (the supervisor) watches the config files and keeps no server
 * state; the server process reports readiness and takes the shutdown request over IPC. A broken
 * `pp-dev.config.*` is caught here before the running server is stopped, and a server process that
 * fails to start after a change leaves the supervisor waiting for the next change, instead of
 * taking the session down.
 */

/** Set in the environment of the server process. */
export const NEXT_SERVER_PROCESS_ENV = 'PP_DEV_NEXT_SERVER_PROCESS';

export function isNextServerProcess(env: Record<string, string | undefined> = process.env): boolean {
  return env[NEXT_SERVER_PROCESS_ENV] === '1';
}

/**
 * Tells the supervisor the server is listening, once what was logged so far is out, so the
 * supervisor's own lines come after it. A no-op without a supervisor.
 */
export function reportNextServerReady(proc: NodeJS.Process = process): void {
  if (typeof proc.send !== 'function') {
    return;
  }

  // With a callback: a message the closed channel cannot take is reported to it, instead of as an
  // `error` event nobody listens for. The supervisor is gone then; its disconnect ends this process.
  const send = () => proc.send!({ type: SUPERVISOR_READY_MESSAGE } satisfies SupervisorMessage, () => {});

  proc.stdout.write('', send);
}

/** What the supervisor needs of a server process; `ChildProcess` as started by {@link forkNextServer}. */
export type NextServerProcess = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'send' | 'kill' | 'on' | 'off'>;

export interface NextSupervisorLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface NextSupervisorOptions {
  projectRoot: string;
  logger: NextSupervisorLogger;
  /** The mode whose `.env` files the server loads (`--mode`). @default 'development' */
  mode?: string;
  /** Loads the pp-dev config afresh and throws when it can't be loaded. @default {@link loadPPDevConfigAfresh} */
  checkConfig?: () => Promise<void>;
  /** Starts a server process. @default {@link forkNextServer} */
  startServerProcess?: () => NextServerProcess;
  /** @default {@link createConfigWatcher} */
  createWatcher?: (projectRoot: string, restart: () => Promise<void>, log: (message: string) => void) => ConfigWatcher;
  /** How long a server process may take to stop before it is killed. @default 10000 */
  stopTimeoutMs?: number;
  /** For tests. @default process */
  processRef?: Pick<NodeJS.Process, 'on' | 'exit'>;
}

/** The server process: this same command line again, marked as the server. */
export function forkNextServer(): ChildProcess {
  const [, script, ...args] = process.argv;

  if (!script) {
    throw new Error('pp-dev next: cannot start the server process, no script in process.argv');
  }

  return fork(script, args, {
    env: { ...process.env, [NEXT_SERVER_PROCESS_ENV]: '1' },
    stdio: 'inherit',
    execArgv: process.execArgv,
  });
}

/**
 * Loads the pp-dev config as the server process does, `.env` files of `mode` first: a config that
 * reads `process.env` (set from `.env`) is valid there, and must be here too, or no change to it
 * would ever pass this check. The values stay in this process, so a server process started after
 * this check inherits the current ones, which its own load keeps.
 */
export async function loadPPDevConfigAfresh(projectRoot: string, mode = 'development'): Promise<void> {
  const [{ loadPPDevEnv }, { clearConfigCache, getConfig }] = await Promise.all([
    import('../lib/env.js'),
    import('../config.js'),
  ]);

  loadPPDevEnv(mode, projectRoot);
  clearConfigCache();
  await getConfig(projectRoot);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the server process, restarting it on config changes, until a signal or the server's own
 * exit ends the command. Resolves only through `processRef.exit`.
 */
export function superviseNextServer(options: NextSupervisorOptions): Promise<void> {
  const {
    projectRoot,
    logger,
    mode = 'development',
    checkConfig = () => loadPPDevConfigAfresh(projectRoot, mode),
    startServerProcess = forkNextServer,
    createWatcher = createConfigWatcher,
    stopTimeoutMs = 10_000,
    processRef = process,
  } = options;

  let server: NextServerProcess | null = null;
  /** The current server process reported that it is listening. */
  let ready = false;
  /** Some server process has been listening: the watcher is on, and a failed start is a failed restart. */
  let everReady = false;
  let watcher: ConfigWatcher | null = null;
  let stopping: Promise<number | null> | null = null;
  let shuttingDown = false;

  return new Promise<void>(() => {
    const exit = async (code: number) => {
      if (watcher) {
        const closing = watcher;

        watcher = null;
        await closing.close();
      }

      processRef.exit(code);
    };

    /** Asks the server process to shut down and waits for it; the exit code, or null if it was killed. */
    const stopServer = (reason: string): Promise<number | null> => {
      const proc = server;

      if (!proc) {
        return Promise.resolve(0);
      }

      if (stopping) {
        return stopping;
      }

      stopping = new Promise<number | null>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          resolve(proc.exitCode);

          return;
        }

        const killTimer = setTimeout(() => {
          logger.warn(colors.yellow(`⏰ The dev server did not stop within ${stopTimeoutMs} ms, killing it`));
          proc.kill('SIGKILL');
        }, stopTimeoutMs);

        proc.on('exit', (code) => {
          clearTimeout(killTimer);
          resolve(code);
        });

        // With a callback: a message the closed channel cannot take (the process is exiting, its
        // `exit` still to come) is reported to it, instead of as an `error` event nobody listens for.
        proc.send({ type: SUPERVISOR_SHUTDOWN_MESSAGE, reason } satisfies SupervisorMessage, () => {});
      }).finally(() => {
        stopping = null;
      });

      return stopping;
    };

    /** Starts a server process; settles once it is listening or has exited, so a restart is whole. */
    const startServer = (): Promise<void> => {
      const proc = startServerProcess();
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => (settle = resolve));

      server = proc;
      ready = false;

      proc.on('message', (message: SupervisorMessage) => {
        if (message?.type !== SUPERVISOR_READY_MESSAGE || server !== proc) {
          return;
        }

        ready = true;
        everReady = true;
        settle();

        if (!watcher && !shuttingDown) {
          watcher = createWatcher(projectRoot, restart, logger.info);
        }
      });

      proc.on('exit', (code, signal) => {
        settle();

        if (server === proc) {
          server = null;
        }

        // A stop the supervisor asked for: its waiter goes on.
        if (stopping || shuttingDown) {
          return;
        }

        const wasReady = ready;
        const exitCode = code ?? 1;

        ready = false;

        if (wasReady) {
          logger.error(colors.red(`❌ The dev server exited (${signal ?? `code ${exitCode}`})`));
          void exit(exitCode);
        } else if (everReady) {
          logger.error(
            colors.red(
              `❌ The dev server did not start after the config change (${signal ?? `code ${exitCode}`}); fix the config and save it again`,
            ),
          );
        } else {
          void exit(exitCode);
        }
      });

      return settled;
    };

    const restart = async () => {
      if (shuttingDown) {
        return;
      }

      try {
        await checkConfig();
      } catch (error) {
        logger.error(
          colors.red(`❌ The pp-dev config could not be loaded, the dev server keeps running: ${describeError(error)}`),
        );

        return;
      }

      await stopServer('a config change');

      if (!shuttingDown) {
        // Until the new server listens (or fails): a change meanwhile restarts once more after it.
        await startServer();
      }
    };

    const shutdown = async (signal: string) => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;

      const code = await stopServer(signal);

      await exit(code ?? 0);
    };

    processRef.on('SIGINT', () => void shutdown('SIGINT'));
    processRef.on('SIGTERM', () => void shutdown('SIGTERM'));
    processRef.on('SIGHUP', () => void shutdown('SIGHUP'));
    // Whatever ends this process, the server must not outlive it.
    processRef.on('exit', () => {
      if (server && server.exitCode === null && server.signalCode === null) {
        server.kill('SIGKILL');
      }
    });

    void startServer();
  });
}
