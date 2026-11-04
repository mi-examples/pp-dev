import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  NEXT_SERVER_PROCESS_ENV,
  isNextServerProcess,
  reportNextServerReady,
  superviseNextServer,
  type NextServerProcess,
} from '../../../src/cli/next-supervisor.js';
import { SUPERVISOR_READY_MESSAGE, SUPERVISOR_SHUTDOWN_MESSAGE } from '../../../src/lib/process-handlers.js';
import type { ConfigWatcher } from '../../../src/cli/config-watcher.js';

/**
 * Regression tests for the `pp-dev next` supervisor.
 *
 * A restart in one process could never apply a changed config: Next.js caches `loadConfig()` for
 * the life of the process, so after an edit of `pp-dev.config.*` under `withPPDev()`, or of
 * `next.config.*`, the restarted server kept the first backend URL and base path. The server now
 * runs in a process of its own, started again on a change. And a config that can't be loaded, or
 * a server that fails to start after a change, no longer ends the command with `process.exit(1)`.
 */

type FakeServer = EventEmitter &
  NextServerProcess & {
    send: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    exit(code: number | null, signal?: NodeJS.Signals | null): void;
    ready(): void;
  };

function fakeServer(): FakeServer {
  const proc = Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    send: vi.fn(),
    kill: vi.fn(),
  });

  return Object.assign(proc, {
    exit(code: number | null, signal: NodeJS.Signals | null = null) {
      proc.exitCode = code;
      proc.signalCode = signal;
      proc.emit('exit', code, signal);
    },
    ready() {
      proc.emit('message', { type: SUPERVISOR_READY_MESSAGE });
    },
  }) as FakeServer;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(overrides: { checkConfig?: () => Promise<void> } = {}) {
  const servers: FakeServer[] = [];
  const processRef = Object.assign(new EventEmitter(), { exit: vi.fn() });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const watcher: ConfigWatcher = {
    watcher: {} as never,
    ready: Promise.resolve(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  let restart: (() => Promise<void>) | null = null;
  const createWatcher = vi.fn((_root: string, callback: () => Promise<void>) => {
    restart = callback;

    return watcher;
  });
  const checkConfig = vi.fn(overrides.checkConfig ?? (() => Promise.resolve()));

  void superviseNextServer({
    projectRoot: '/app',
    logger,
    checkConfig,
    startServerProcess: () => {
      const server = fakeServer();

      servers.push(server);

      return server;
    },
    createWatcher,
    stopTimeoutMs: 30,
    processRef: processRef as never,
  });

  const output = () =>
    [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls].map(String).join('\n');

  return {
    servers,
    processRef,
    logger,
    watcher,
    createWatcher,
    checkConfig,
    output,
    restart: () => {
      if (!restart) {
        throw new Error('no watcher yet');
      }

      return restart();
    },
  };
}

describe('superviseNextServer', () => {
  it('starts the server process, and the config watcher once it is listening', () => {
    const { servers, createWatcher } = setup();

    expect(servers).toHaveLength(1);
    expect(createWatcher).not.toHaveBeenCalled();

    servers[0].ready();

    expect(createWatcher).toHaveBeenCalledWith('/app', expect.any(Function), expect.any(Function));
  });

  it("exits with the server's code when the first start fails", async () => {
    const { servers, processRef, createWatcher } = setup();

    servers[0].exit(1);
    await flush();

    expect(processRef.exit).toHaveBeenCalledWith(1);
    expect(createWatcher).not.toHaveBeenCalled();
  });

  it('restarts on a config change: checks the config, stops the server, starts a new one', async () => {
    const { servers, checkConfig, createWatcher, restart } = setup();

    servers[0].ready();

    const restarted = restart();

    await flush();

    expect(checkConfig).toHaveBeenCalledTimes(1);
    expect(servers[0].send).toHaveBeenCalledWith({ type: SUPERVISOR_SHUTDOWN_MESSAGE, reason: 'a config change' });
    expect(servers).toHaveLength(1);

    servers[0].exit(0);
    await flush();

    expect(servers).toHaveLength(2);

    // The restart is over once the new server listens: a change meanwhile waits for it.
    const settledEarly = await Promise.race([restarted.then(() => true), flush().then(() => false)]);

    expect(settledEarly).toBe(false);

    servers[1].ready();
    await restarted;

    expect(createWatcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the running server when the pp-dev config cannot be loaded', async () => {
    const { servers, restart, output } = setup({ checkConfig: () => Promise.reject(new Error('Unexpected "}"')) });

    servers[0].ready();
    await restart();

    expect(servers[0].send).not.toHaveBeenCalled();
    expect(servers).toHaveLength(1);
    expect(output()).toContain('could not be loaded, the dev server keeps running: Unexpected "}"');
  });

  it('kills a server that does not stop in time, and starts the new one', async () => {
    const { servers, restart, output } = setup();

    servers[0].ready();

    const restarted = restart();

    await vi.waitFor(() => expect(servers[0].kill).toHaveBeenCalledWith('SIGKILL'));
    expect(output()).toContain('did not stop within 30 ms');

    servers[0].exit(null, 'SIGKILL');
    await flush();

    expect(servers).toHaveLength(2);

    servers[1].ready();
    await restarted;
  });

  it('waits for the next change when the server fails to start after one', async () => {
    const { servers, processRef, restart, output } = setup();

    servers[0].ready();

    const restarted = restart();

    await flush();
    servers[0].exit(0);
    await flush();
    servers[1].exit(1);
    await restarted;

    expect(processRef.exit).not.toHaveBeenCalled();
    expect(output()).toContain('did not start after the config change (code 1); fix the config and save it again');

    void restart();
    await flush();

    expect(servers).toHaveLength(3);
  });

  it('exits with its code when the running server exits on its own', async () => {
    const { servers, processRef, watcher, output } = setup();

    servers[0].ready();
    servers[0].exit(1);
    await flush();

    expect(output()).toContain('The dev server exited (code 1)');
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(processRef.exit).toHaveBeenCalledWith(1);
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'])(
    'on %s asks the server to shut down and exits with its code',
    async (signal) => {
      const { servers, processRef, watcher } = setup();

      servers[0].ready();
      processRef.emit(signal);
      await flush();

      expect(servers[0].send).toHaveBeenCalledWith({ type: SUPERVISOR_SHUTDOWN_MESSAGE, reason: signal });
      expect(processRef.exit).not.toHaveBeenCalled();

      servers[0].exit(0);
      await flush();

      expect(watcher.close).toHaveBeenCalledTimes(1);
      expect(processRef.exit).toHaveBeenCalledWith(0);
    },
  );

  it('asks once on a second signal, and ignores a config change while shutting down', async () => {
    const { servers, processRef, restart } = setup();

    servers[0].ready();
    processRef.emit('SIGINT');
    processRef.emit('SIGINT');
    await restart();
    await flush();

    expect(servers[0].send).toHaveBeenCalledTimes(1);
    expect(servers).toHaveLength(1);
  });

  it('exits with 0 on a signal when no server is running', async () => {
    const { servers, processRef, restart } = setup();

    servers[0].ready();

    const restarted = restart();

    await flush();
    servers[0].exit(0);
    await flush();
    servers[1].exit(1);
    await restarted;

    processRef.emit('SIGTERM');
    await flush();

    expect(processRef.exit).toHaveBeenCalledWith(0);
  });

  it('kills the server when the supervisor process exits for any reason', () => {
    const { servers, processRef } = setup();

    processRef.emit('exit');

    expect(servers[0].kill).toHaveBeenCalledWith('SIGKILL');
  });
});

describe('the server process side', () => {
  it('is marked by the environment', () => {
    expect(isNextServerProcess({})).toBe(false);
    expect(isNextServerProcess({ [NEXT_SERVER_PROCESS_ENV]: '1' })).toBe(true);
  });

  it('reports readiness after what was logged is written, and not at all without a supervisor', () => {
    const send = vi.fn();
    const write = vi.fn((_chunk: string, callback: () => void) => callback());

    reportNextServerReady({ send, stdout: { write } } as never);

    expect(write).toHaveBeenCalledWith('', expect.any(Function));
    expect(send).toHaveBeenCalledWith({ type: SUPERVISOR_READY_MESSAGE });

    reportNextServerReady({ stdout: { write } } as never);

    expect(write).toHaveBeenCalledTimes(1);
  });
});
