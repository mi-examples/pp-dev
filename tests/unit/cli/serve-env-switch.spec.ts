import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * PP-4840 phase 4 under `pp-dev` (Vite): the dev panel's switch restarts the Vite server in the same
 * process. A new server that fails to listen has stopped the running one already: a server starts
 * again in the environment it had, and tells the tabs waiting for the switch why it failed.
 */

const vite = vi.hoisted(() => ({ servers: [] as any[], next: [] as Array<(server: any) => void> }));

vi.mock('vite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vite')>()),
  createServer: vi.fn(async () => {
    const server = {
      httpServer: {},
      listen: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      printUrls: vi.fn(),
      resolvedUrls: { local: ['http://localhost:5173/'] },
      config: { server: {} },
    };

    vite.next.shift()?.(server);
    vite.servers.push(server);

    return server;
  }),
  mergeConfig: (a: object, b: object) => ({ ...a, ...b }),
}));

vi.mock('../../../src/config.js', () => ({
  clearConfigCache: vi.fn(),
  getConfig: vi.fn(async () => ({ inspector: { enabled: false } })),
  getNamedConfigFile: vi.fn(() => undefined),
}));

vi.mock('../../../src/cli/vite-config.js', () => ({
  loadCommandViteConfig: vi.fn(async () => ({
    config: { base: '/pl/app/' },
    envDir: '/app',
    configFile: undefined,
    viteEnvFiles: [],
  })),
  takeViteEnvFiles: vi.fn(() => []),
}));

vi.mock('../../../src/cli/config-watcher.js', () => ({
  createConfigWatcher: vi.fn(() => ({ add: vi.fn() })),
  cleanupConfigWatcher: vi.fn(async () => undefined),
}));

vi.mock('../../../src/lib/process-handlers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/process-handlers.js')>()),
  registerProcessHandlers: vi.fn(),
}));

vi.mock('../../../src/shortcuts.js', () => ({ bindShortcuts: vi.fn() }));

vi.mock('../../../src/cli/profiler.js', () => ({ stopProfiler: vi.fn(), profilerShortcuts: () => [] }));

const { registerServeCommand } = await import('../../../src/cli/commands/serve.js');
const { getEnvSwitchFailure, requestEnvSwitch, setEnvSwitchHandler } = await import('../../../src/lib/env-switch.js');

/** Runs the serve command's action as the CLI would, and waits for its first server. */
async function serve() {
  let action!: (root: string | undefined, options: object) => Promise<void>;
  const command = {
    alias: () => command,
    option: () => command,
    action: (fn: typeof action) => {
      action = fn;

      return command;
    },
  };

  registerServeCommand({ command: () => command } as never);
  await action(undefined, { logLevel: 'silent' });
}

describe('pp-dev — switching the MI environment', () => {
  afterEach(() => {
    vite.servers = [];
    vite.next = [];
    setEnvSwitchHandler(undefined);
    delete process.env.PP_DEV_SWITCHED_ENV;
    delete process.env.PP_DEV_ENV_SWITCH_FAILURE;
  });

  it('restarts in the choice, and keeps it', async () => {
    await serve();

    await expect(requestEnvSwitch('stg70')).resolves.toEqual({ ok: true });

    expect(vite.servers).toHaveLength(2);
    expect(vite.servers[0].close).toHaveBeenCalled();
    expect(vite.servers[1].listen).toHaveBeenCalled();
    expect(process.env.PP_DEV_SWITCHED_ENV).toBe('stg70');
  });

  // The new server failed to listen after the running one was stopped: no server was left, and the
  // failure went over the stopped one's WebSocket.
  it('starts a server again as it was when the new one fails to listen, and tells why', async () => {
    await serve();

    let startedWith: string | undefined;

    vite.next.push((server) => server.listen.mockRejectedValue(new Error('listen EADDRINUSE')));
    vite.next.push(() => {
      startedWith = process.env.PP_DEV_SWITCHED_ENV;
    });

    await expect(requestEnvSwitch('stg70')).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('EADDRINUSE'),
    });

    expect(vite.servers).toHaveLength(3);
    expect(vite.servers[2].listen).toHaveBeenCalled();
    expect(startedWith).toBeUndefined();
    expect(process.env.PP_DEV_SWITCHED_ENV).toBeUndefined();
    expect(getEnvSwitchFailure()).toEqual({ name: 'stg70', error: expect.stringContaining('EADDRINUSE') });
  });

  it('keeps the running server when the new one is refused before it', async () => {
    await serve();

    const { loadCommandViteConfig } = await import('../../../src/cli/vite-config.js');

    vi.mocked(loadCommandViteConfig).mockRejectedValueOnce(new Error('MI environment "stg70" has no URL'));

    await expect(requestEnvSwitch('stg70')).resolves.toEqual({
      ok: false,
      error: 'MI environment "stg70" has no URL',
    });

    expect(vite.servers).toHaveLength(1);
    expect(vite.servers[0].close).not.toHaveBeenCalled();
    expect(getEnvSwitchFailure()).toBeUndefined();
  });
});
