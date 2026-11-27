import { fork, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { colors } from '../lib/helpers/color.helper.js';
import { PP_DEV_CONFIG_FILE_ENV_VAR } from '../constants.js';
import { PP_DEV_SWITCHED_ENV_VAR } from '../shared/mi-environments.js';
import { setEnvSwitchFailure, setPendingEnvSwitch } from '../lib/env-switch.js';
import {
  SUPERVISOR_ENV_SWITCH_FAILED_MESSAGE,
  SUPERVISOR_ENV_SWITCH_MESSAGE,
  SUPERVISOR_READY_MESSAGE,
  SUPERVISOR_SHUTDOWN_MESSAGE,
  type SupervisorMessage,
} from '../lib/process-handlers.js';
import type { EnvSwitchResult } from '../lib/env-switch.js';
import {
  createConfigWatcher,
  envFilesForMode,
  type ConfigWatcher,
  type ConfigWatcherOptions,
} from './config-watcher.js';

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
 * or invalid `pp-dev.config.*` is caught here before the running server is stopped, and a server
 * process that fails to start after a change (or could not be started at all) leaves the supervisor
 * waiting for the next change, instead of taking the session down.
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

/**
 * The server process's way to switch MI environments (PP-4840 phase 4): the supervisor starts a server
 * process in `name` and this one ends, or answers why it didn't. Without a supervisor there is none.
 */
export function requestEnvSwitchFromSupervisor(name: string, proc: NodeJS.Process = process): Promise<EnvSwitchResult> {
  if (typeof proc.send !== 'function') {
    return Promise.resolve({ ok: false, error: 'This dev server has no supervisor to restart it.' });
  }

  return new Promise<EnvSwitchResult>((resolve) => {
    const onMessage = (message: SupervisorMessage) => {
      if (message?.type === SUPERVISOR_ENV_SWITCH_FAILED_MESSAGE && message.name === name && !message.unrequested) {
        proc.off('message', onMessage);
        resolve({ ok: false, error: message.error });
      }
    };

    proc.on('message', onMessage);
    proc.send!({ type: SUPERVISOR_ENV_SWITCH_MESSAGE, name } satisfies SupervisorMessage, () => {});
  });
}

/**
 * In a server process: a switch another one asked for failed. It was asked before a restart stopped
 * that one, and the supervisor refused it after: the tabs waiting for it are this server's now.
 */
export function onUnrequestedEnvSwitchFailure(
  handler: (failure: { name: string; error: string }) => void,
  proc: Pick<NodeJS.Process, 'on' | 'off'> = process,
): () => void {
  const onMessage = (message: SupervisorMessage) => {
    if (message?.type === SUPERVISOR_ENV_SWITCH_FAILED_MESSAGE && message.unrequested) {
      handler({ name: message.name, error: message.error });
    }
  };

  proc.on('message', onMessage);

  return () => proc.off('message', onMessage);
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
  createWatcher?: (
    projectRoot: string,
    restart: () => Promise<void>,
    log: (message: string) => void,
    options?: ConfigWatcherOptions,
  ) => ConfigWatcher;
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
 *
 * Validated as the server process validates it, too: a config that loads but is refused there
 * (`sync.buildTimeoutMs: 0`) passed this check, the running server was stopped, and the new one
 * refused the config, leaving none.
 *
 * Only a standalone config is checked. A project whose pp-dev config lives in `next.config` alone
 * (`withPPDev()`) has none here: validating the empty config in its place refused every change,
 * and nothing was ever restarted. The server process loads `next.config`; one that can't be
 * loaded is reported as a server that did not start after the change.
 */
export async function loadPPDevConfigAfresh(projectRoot: string, mode = 'development'): Promise<void> {
  const [{ loadPPDevEnv }, { clearConfigCache, findConfig, getPkg }, { validatePPDevConfig }] = await Promise.all([
    import('../lib/env.js'),
    import('../config.js'),
    import('../lib/pp-dev-config.js'),
  ]);

  loadPPDevEnv(mode, projectRoot);
  clearConfigCache();

  const { config, found } = await findConfig(projectRoot);

  if (!found) {
    return;
  }

  // Partial: `withPPDev()` in `next.config` may add to it, an environment (`envs`) among the rest.
  validatePPDevConfig(config, getPkg(projectRoot).name, { partial: true });
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
        if (message?.type === SUPERVISOR_ENV_SWITCH_MESSAGE && server === proc && typeof message.name === 'string') {
          void switchEnvironment(message.name, proc);

          return;
        }

        if (message?.type !== SUPERVISOR_READY_MESSAGE || server !== proc) {
          return;
        }

        ready = true;
        everReady = true;
        settle();

        if (!watcher && !shuttingDown) {
          // The `.env` files of the mode pp-dev loads, and the development ones Next's dev server
          // loads itself, whatever `--mode` says.
          // A pp-dev config named with `--pp-config` too, wherever it is.
          const namedConfigFile = process.env[PP_DEV_CONFIG_FILE_ENV_VAR]?.trim();

          watcher = createWatcher(projectRoot, restart, logger.info, {
            mode,
            files: [
              ...envFilesForMode('development').map((name) => path.join(projectRoot, name)),
              ...(namedConfigFile ? [path.resolve(namedConfigFile)] : []),
            ],
          });
        }
      });

      let ended = false;

      const onEnd = (code: number | null, signal: NodeJS.Signals | null, failure?: string) => {
        if (ended) {
          return;
        }

        ended = true;
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
        const how = failure ?? signal ?? `code ${exitCode}`;

        ready = false;

        if (wasReady) {
          logger.error(colors.red(`❌ The dev server exited (${how})`));
          void exit(exitCode);
        } else if (everReady) {
          logger.error(
            colors.red(
              `❌ The dev server did not start after the config change (${how}); fix the config and save it again`,
            ),
          );
        } else {
          void exit(exitCode);
        }
      };

      proc.on('exit', (code, signal) => onEnd(code, signal));
      // A process the OS could not start (EAGAIN, EMFILE) reports it here and never exits: the
      // event ended the supervisor, nobody listening, and a restart's start never settled.
      proc.on('error', (error) => onEnd(1, null, describeError(error)));

      return settled;
    };

    // Restarts on a config change and the dev panel's environment switches, one after another: two at
    // once would start two server processes, one of them untracked, and it would outlive a shutdown.
    let restarts: Promise<unknown> = Promise.resolve();
    const oneAtATime = (run: () => Promise<void>): Promise<void> => {
      const next = restarts.then(run, run);

      restarts = next.catch(() => undefined);

      return next;
    };

    const restart = () => oneAtATime(restartNow);

    const restartNow = async () => {
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

    /**
     * The dev panel's switch to MI environment `name` (PP-4840 phase 4): a server process started with
     * the choice over `--env`, `MI_ENV` and `defaultEnv` (it gets this process's environment), kept
     * until pp-dev stops. A config the check refuses keeps the running server, which is told why. The
     * running server is stopped before the new one starts (one port), so a choice whose server didn't
     * start (a config only `next.config` has, which the check can't see) is taken back and a server
     * starts again in the environment it had.
     */
    // While it waits (behind a restart on a config change), a server process started meanwhile gets
    // it marked pending, and takes no sync the switch would end; the switch's own doesn't.
    const switchEnvironment = (name: string, requester: NextServerProcess) => {
      setPendingEnvSwitch(name);

      return oneAtATime(() => switchEnvironmentNow(name, requester));
    };

    const switchEnvironmentNow = async (name: string, requester: NextServerProcess) => {
      setPendingEnvSwitch(undefined);

      if (shuttingDown) {
        return;
      }

      const previous = process.env[PP_DEV_SWITCHED_ENV_VAR];
      const takeBack = () => {
        if (previous === undefined) {
          delete process.env[PP_DEV_SWITCHED_ENV_VAR];
        } else {
          process.env[PP_DEV_SWITCHED_ENV_VAR] = previous;
        }
      };

      process.env[PP_DEV_SWITCHED_ENV_VAR] = name;

      try {
        await checkConfig();
      } catch (error) {
        takeBack();

        const failed = { type: SUPERVISOR_ENV_SWITCH_FAILED_MESSAGE, name, error: describeError(error) } as const;

        requester.send(failed satisfies SupervisorMessage, () => {});

        // Asked before a restart it waited for: the server that asked is gone, its tabs are the
        // running one's now.
        if (server && server !== requester) {
          server.send({ ...failed, unrequested: true } satisfies SupervisorMessage, () => {});
        }

        return;
      }

      logger.info(colors.blue(`🧭 Switching to the MI environment ${name}`));
      await stopServer(`a switch to the MI environment ${name}`);

      if (shuttingDown) {
        return;
      }

      await startServer();

      if (!ready && !shuttingDown) {
        takeBack();
        logger.warn(
          colors.yellow(`⚠️  The dev server did not start in the MI environment ${name}: starting it again as it was`),
        );
        // The process that told the tabs of the switch is gone: the one started again tells the tabs
        // that wait for it (`GET /@api/environment`). Its own, not the processes started after it.
        setEnvSwitchFailure({ name, error: `The dev server did not start in ${name}: see its terminal.` });
        await startServer();
        setEnvSwitchFailure(undefined);
      }
    };

    const shutdown = async (signal: string) => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;

      const code = await stopServer(signal);

      // Killed (the shutdown did not finish in time), or ended by a signal of its own: not a clean
      // shutdown, which 0 would report.
      await exit(code ?? 1);
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
