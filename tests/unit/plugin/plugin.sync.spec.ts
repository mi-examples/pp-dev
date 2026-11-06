import { describe, expect, it, vi } from 'vitest';
import type { ViteDevServer } from 'vite';

const distServiceConstructor = vi.hoisted(() => vi.fn());
/** Every dev panel service made, in order, each with a `dispose` spy of its own. */
const clientServices = vi.hoisted(() => [] as Array<{ dispose: ReturnType<typeof vi.fn> }>);

vi.mock('../../../src/lib/dist.service.js', () => ({
  DistService: class {
    constructor(...args: unknown[]) {
      distServiceConstructor(...args);
    }
  },
}));

vi.mock('../../../src/lib/client.service.js', () => ({
  ClientService: class {
    dispose = vi.fn();

    constructor() {
      clientServices.push(this);
    }
  },
}));

vi.mock('../../../src/lib/variables-editor.js', () => ({
  VARIABLES_EDITOR_PATH: '/@pp-dev/variables-editor',
  registerVariablesEditorRoutes: vi.fn(),
}));

const { normalizePPDevConfig, vitePPDev } = await import('../../../src/plugin.js');

type PPDevPlugin = ReturnType<typeof vitePPDev>;

function pluginFor(sync?: { backupsDir?: string; buildTimeoutMs?: number }): PPDevPlugin {
  return vitePPDev(
    normalizePPDevConfig(
      {
        app: { id: 123, type: 'template' },
        inspector: { enabled: false },
        mi: { url: 'https://mi.example.com' },
        proxy: { cache: false },
        ...(sync ? { sync } : {}),
      },
      'test-app',
    ),
  );
}

/** What the plugin's configureServer reads of a dev server; its client environment stands for it. */
function fakeServer(): ViteDevServer {
  return {
    config: { base: '/', logger: { error: vi.fn(), info: vi.fn() } },
    middlewares: { use: vi.fn() },
    ws: {},
    environments: { client: {} },
  } as unknown as ViteDevServer;
}

function configure(plugin: PPDevPlugin, server: ViteDevServer) {
  (plugin.configureServer as (server: ViteDevServer) => void)(server);
}

/** closeBundle as Vite runs it when a dev server closes: once per environment, with that environment. */
function closeServer(plugin: PPDevPlugin, server: ViteDevServer) {
  const closeBundle = plugin.closeBundle as (this: { environment: unknown }) => void;

  closeBundle.call({ environment: server.environments.client });
  closeBundle.call({ environment: {} });
}

describe('vitePPDev sync configuration', () => {
  it('passes sync.backupsDir to DistService as backupFolder', () => {
    configure(pluginFor({ backupsDir: 'archives' }), fakeServer());

    expect(distServiceConstructor).toHaveBeenCalledWith(
      'test-app',
      expect.objectContaining({ backupFolder: 'archives' }),
    );
  });
});

describe('vitePPDev sync build timeout', () => {
  it('passes sync.buildTimeoutMs to DistService', () => {
    configure(pluginFor({ buildTimeoutMs: 1_800_000 }), fakeServer());

    expect(distServiceConstructor).toHaveBeenLastCalledWith(
      'test-app',
      expect.objectContaining({ buildTimeoutMs: 1_800_000 }),
    );
  });
});

// Vite takes `ws.on('close')` for a message from a page and never calls it on shutdown: a sync's
// build outlived the dev server. The plugin's closeBundle, which Vite runs when the dev server closes
// (or restarts), disposes the panel's service instead.
describe('vitePPDev on dev server close', () => {
  it("disposes the dev panel's service, once", () => {
    const plugin = pluginFor();
    const server = fakeServer();

    configure(plugin, server);

    const service = clientServices.at(-1)!;

    closeServer(plugin, server);
    closeServer(plugin, server);

    expect(service.dispose).toHaveBeenCalledTimes(1);
  });

  // Vite's own restart (the `r` shortcut, a change of vite.config.*) makes the new server with the
  // same plugin instance, then closes the old one. The service disposed was the new server's: every
  // sync after that failed with "pp-dev build was stopped", and the old server's sync ran on.
  it("disposes the closing server's service, not that of the server replacing it", () => {
    const plugin = pluginFor();
    const first = fakeServer();
    const second = fakeServer();

    configure(plugin, first);

    const firstService = clientServices.at(-1)!;

    configure(plugin, second);

    const secondService = clientServices.at(-1)!;

    closeServer(plugin, first);

    expect(firstService.dispose).toHaveBeenCalledTimes(1);
    expect(secondService.dispose).not.toHaveBeenCalled();

    closeServer(plugin, second);

    expect(secondService.dispose).toHaveBeenCalledTimes(1);
  });
});
