import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  NEXT_SERVER_PROCESS_ENV,
  isNextServerProcess,
  loadPPDevConfigAfresh,
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

function setup(overrides: { checkConfig?: () => Promise<void>; mode?: string } = {}) {
  const servers: FakeServer[] = [];
  const processRef = Object.assign(new EventEmitter(), { exit: vi.fn() });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const watcher: ConfigWatcher = {
    watcher: {} as never,
    ready: Promise.resolve(),
    add: vi.fn(),
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
    ...(overrides.mode ? { mode: overrides.mode } : {}),
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

    expect(createWatcher).toHaveBeenCalledWith(
      '/app',
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({ mode: 'development' }),
    );
  });

  // Next's development phase loads `.env.development*` whatever pp-dev's `--mode`: with
  // `--mode staging` a change to them restarted nothing.
  it("watches Next's development .env files whatever the mode", () => {
    const { servers, createWatcher } = setup({ mode: 'staging' });

    servers[0].ready();

    const options = (createWatcher.mock.calls[0] as unknown[] | undefined)?.[3] as { mode?: string; files?: string[] };

    expect(options.mode).toBe('staging');
    expect(options.files).toEqual(
      ['.env', '.env.local', '.env.development', '.env.development.local'].map((name) => path.join('/app', name)),
    );
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
    expect(servers[0].send).toHaveBeenCalledWith(
      { type: SUPERVISOR_SHUTDOWN_MESSAGE, reason: 'a config change' },
      expect.any(Function),
    );
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

  // `send()` on a channel that closed before the process's `exit` reports ERR_IPC_CHANNEL_CLOSED
  // through an `error` event when it gets no callback, and nothing listened for it.
  it('takes a shutdown message the closed channel cannot deliver as sent', async () => {
    const { servers, restart } = setup();

    servers[0].ready();
    servers[0].send.mockImplementation((_message: unknown, callback: (error: Error) => void) => {
      callback(new Error('Channel closed'));

      return false;
    });

    const restarted = restart();

    await flush();

    expect(servers[0].send).toHaveBeenCalledTimes(1);

    servers[0].exit(0);
    await flush();
    servers[1].ready();
    await restarted;

    expect(servers).toHaveLength(2);
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

  // A process the OS could not start (EAGAIN, EMFILE) emits `error` and never `exit`: the event
  // ended the supervisor, nobody listening, and the restart never settled.
  it('waits for the next change when the server process could not be started after one', async () => {
    const { servers, processRef, restart, output } = setup();

    servers[0].ready();

    const restarted = restart();

    await flush();
    servers[0].exit(0);
    await flush();
    servers[1].emit('error', new Error('spawn EAGAIN'));
    await restarted;

    expect(processRef.exit).not.toHaveBeenCalled();
    expect(output()).toContain(
      'did not start after the config change (spawn EAGAIN); fix the config and save it again',
    );

    void restart();
    await flush();

    expect(servers).toHaveLength(3);
  });

  it('exits with 1 when the first server process could not be started', async () => {
    const { servers, processRef } = setup();

    servers[0].emit('error', new Error('spawn EMFILE'));
    await flush();

    expect(processRef.exit).toHaveBeenCalledWith(1);
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

      expect(servers[0].send).toHaveBeenCalledWith(
        { type: SUPERVISOR_SHUTDOWN_MESSAGE, reason: signal },
        expect.any(Function),
      );
      expect(processRef.exit).not.toHaveBeenCalled();

      servers[0].exit(0);
      await flush();

      expect(watcher.close).toHaveBeenCalledTimes(1);
      expect(processRef.exit).toHaveBeenCalledWith(0);
    },
  );

  // The forced kill resolved with no code, reported as 0: a shutdown that did not finish read as clean.
  it('exits with 1 when the server had to be killed on a signal', async () => {
    const { servers, processRef, output } = setup();

    servers[0].ready();
    processRef.emit('SIGTERM');

    await vi.waitFor(() => expect(servers[0].kill).toHaveBeenCalledWith('SIGKILL'));
    expect(output()).toContain('did not stop within 30 ms');

    servers[0].exit(null, 'SIGKILL');
    await flush();

    expect(processRef.exit).toHaveBeenCalledWith(1);
  });

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
    // With a callback: a message the closed channel cannot take must not become an `error` event.
    expect(send).toHaveBeenCalledWith({ type: SUPERVISOR_READY_MESSAGE }, expect.any(Function));

    reportNextServerReady({ stdout: { write } } as never);

    expect(write).toHaveBeenCalledTimes(1);
  });
});

// The server process loads the `.env` files before the config, so a config that reads a value from
// them is valid there. The supervisor's check loaded the config alone: such a config failed it on
// every save, and no change to it was ever applied.
describe("the supervisor's config check", () => {
  let root: string;

  afterEach(() => {
    delete process.env.MI_SUPERVISOR_URL;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('loads the .env files of the mode first, as the server process does', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-supervisor-env-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"env-app"}');
    fs.writeFileSync(path.join(root, '.env'), 'MI_SUPERVISOR_URL=https://mi.example.com\n');
    fs.writeFileSync(
      path.join(root, 'pp-dev.config.mjs'),
      [
        'const url = process.env.MI_SUPERVISOR_URL;',
        "if (!url) throw new Error('MI_SUPERVISOR_URL is not set');",
        "export default { mi: { url }, app: { id: 1, type: 'template' } };",
        '',
      ].join('\n'),
    );

    await expect(loadPPDevConfigAfresh(root, 'development')).resolves.toBeUndefined();
  });

  // A project whose pp-dev config lives in next.config alone (`withPPDev()`) has no standalone
  // config: the check validated an empty one in its place and refused every change.
  it('passes a project whose pp-dev config lives in next.config alone', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-supervisor-next-only-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"next-only-app"}');
    fs.writeFileSync(path.join(root, 'next.config.mjs'), 'export default {};\n');

    await expect(loadPPDevConfigAfresh(root, 'development')).resolves.toBeUndefined();
  });

  // A config file that exports nothing counted as no config: the check passed, the working server
  // was stopped, and the new one refused the empty config.
  it('refuses a config file that exports nothing', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-supervisor-null-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"null-app"}');
    fs.writeFileSync(path.join(root, 'pp-dev.config.mjs'), 'export default null;\n');

    await expect(loadPPDevConfigAfresh(root, 'development')).rejects.toThrow(/mi\.url/);
  });

  it('refuses a broken package.json config', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-supervisor-pkg-'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      '{"name":"pkg-app","pp-dev":{"mi":{"url":"https://mi.example.com"},"app":{"id":1,"type":"template"},"sync":{"buildTimeoutMs":0}}}',
    );

    await expect(loadPPDevConfigAfresh(root, 'development')).rejects.toThrow(/sync\.buildTimeoutMs/);
  });

  // A config that loads but the server process refuses passed the check: the running server was
  // stopped, and the new one refused the config, leaving none.
  it('refuses a config the server process would refuse, before the running server is stopped', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-supervisor-invalid-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"invalid-app"}');
    fs.writeFileSync(
      path.join(root, 'pp-dev.config.mjs'),
      "export default { mi: { url: 'https://mi.example.com' }, app: { id: 1, type: 'template' }, sync: { buildTimeoutMs: 0 } };\n",
    );

    await expect(loadPPDevConfigAfresh(root, 'development')).rejects.toThrow(/sync\.buildTimeoutMs/);
  });
});
