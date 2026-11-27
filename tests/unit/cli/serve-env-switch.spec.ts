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
const { getEnvSwitchFailure, getPendingEnvSwitch, requestEnvSwitch, setEnvSwitchHandler } =
  await import('../../../src/lib/env-switch.js');
const { createConfigWatcher } = await import('../../../src/cli/config-watcher.js');
const { userRegistry } = await import('../../../src/lib/user-registry.js');
const { originalSession } = await import('../../../src/lib/original-session.js');

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
    delete process.env.PP_DEV_ENV_SWITCH_PENDING;
    userRegistry.clear();
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

  // A config change restarted the server while the switch waited behind it: the new server took a
  // sync, which the switch then ended.
  it('marks the switch pending while it waits behind a restart, and until it is over', async () => {
    await serve();

    const restartOnChange = vi.mocked(createConfigWatcher).mock.calls.at(-1)![1] as () => Promise<void>;
    let listened!: () => void;
    let pendingInSwitch: string | undefined;

    vite.next.push((server) => server.listen.mockReturnValue(new Promise<void>((resolve) => (listened = resolve))));
    vite.next.push(() => {
      pendingInSwitch = getPendingEnvSwitch();
    });

    const restarting = restartOnChange();

    await vi.waitFor(() => expect(listened).toBeDefined());

    const switching = requestEnvSwitch('stg70');

    // The restart's server is up while the switch waits: no sync for it.
    listened();
    await restarting;
    expect(getPendingEnvSwitch()).toBe('stg70');

    await expect(switching).resolves.toEqual({ ok: true });
    expect(pendingInSwitch).toBe('stg70');
    expect(getPendingEnvSwitch()).toBeUndefined();
  });

  // Setting the new server up ties the users to its MI instance, and forgets the login, before it can
  // still fail: the server that stayed kept the new instance's users, whose tokens went to the old.
  describe("the old server's users after a failed switch", () => {
    /** What the new server's setup does for another MI instance (startKeepingUsers). */
    const setUpForTarget = () => {
      userRegistry.useContext('stg70 instance');
      userRegistry.add({ name: 'target', kind: 'token', token: 'stg70-token' });
      originalSession.clear();
    };

    const usersBefore = () => {
      userRegistry.useContext('mi instance');
      userRegistry.add({ name: 'alice', kind: 'token', token: 'mi-token' });
    };

    it('are put back when the new server fails before the running one stops', async () => {
      await serve();
      usersBefore();

      vite.next.push(() => {
        setUpForTarget();
        throw new Error('a plugin failed');
      });

      await expect(requestEnvSwitch('stg70')).resolves.toMatchObject({ ok: false, error: 'a plugin failed' });

      expect(vite.servers[0].close).not.toHaveBeenCalled();
      expect(userRegistry.context).toBe('mi instance');
      expect(userRegistry.list().map((user) => user.name)).toEqual(['alice']);
    });

    // The running server took the change while the config loaded: putting the users back undid it.
    it('keep what the running server changed when the config is refused', async () => {
      await serve();
      usersBefore();

      const { loadCommandViteConfig } = await import('../../../src/cli/vite-config.js');

      vi.mocked(loadCommandViteConfig).mockImplementationOnce(async () => {
        userRegistry.remove('alice');
        throw new Error('MI environment "stg70" has no URL');
      });

      await expect(requestEnvSwitch('stg70')).resolves.toMatchObject({ ok: false });

      expect(userRegistry.context).toBe('mi instance');
      expect(userRegistry.list()).toEqual([]);
    });

    it('are put back for the server started again when the new one fails to listen', async () => {
      await serve();
      usersBefore();

      vite.next.push((server) => {
        setUpForTarget();
        server.listen.mockRejectedValue(new Error('listen EADDRINUSE'));
      });

      await requestEnvSwitch('stg70');

      expect(vite.servers).toHaveLength(3);
      expect(userRegistry.context).toBe('mi instance');
      expect(userRegistry.list().map((user) => user.name)).toEqual(['alice']);
    });
  });
});
