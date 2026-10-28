import { describe, expect, it, vi } from 'vitest';
import type { ViteDevServer } from 'vite';

const distServiceConstructor = vi.hoisted(() => vi.fn());
const clientServiceDispose = vi.hoisted(() => vi.fn());

vi.mock('../../../src/lib/dist.service.js', () => ({
  DistService: class {
    constructor(...args: unknown[]) {
      distServiceConstructor(...args);
    }
  },
}));

vi.mock('../../../src/lib/client.service.js', () => ({
  ClientService: class {
    dispose = clientServiceDispose;
  },
}));

vi.mock('../../../src/lib/variables-editor.js', () => ({
  VARIABLES_EDITOR_PATH: '/@pp-dev/variables-editor',
  registerVariablesEditorRoutes: vi.fn(),
}));

const { normalizePPDevConfig, vitePPDev } = await import('../../../src/plugin.js');

describe('vitePPDev sync configuration', () => {
  it('passes sync.backupsDir to DistService as backupFolder', () => {
    const options = normalizePPDevConfig(
      {
        app: { id: 123, type: 'template' },
        inspector: { enabled: false },
        mi: { url: 'https://mi.example.com' },
        proxy: { cache: false },
        sync: { backupsDir: 'archives' },
      },
      'test-app',
    );
    const plugin = vitePPDev(options);
    const server = {
      config: {
        base: '/',
        logger: {
          error: vi.fn(),
          info: vi.fn(),
        },
      },
      middlewares: {
        use: vi.fn(),
      },
      ws: {},
    } as unknown as ViteDevServer;

    expect(plugin.configureServer).toBeTypeOf('function');
    (plugin.configureServer as (server: ViteDevServer) => void)(server);

    expect(distServiceConstructor).toHaveBeenCalledWith(
      'test-app',
      expect.objectContaining({ backupFolder: 'archives' }),
    );
  });
});

// Vite takes `ws.on('close')` for a message from a page and never calls it on shutdown: a sync's
// build outlived the dev server. The plugin's closeBundle, which Vite runs when the dev server closes
// (or restarts), disposes the panel's service instead.
describe('vitePPDev on dev server close', () => {
  it("disposes the dev panel's service, once", () => {
    const options = normalizePPDevConfig(
      {
        app: { id: 123, type: 'template' },
        inspector: { enabled: false },
        mi: { url: 'https://mi.example.com' },
        proxy: { cache: false },
      },
      'test-app',
    );
    const plugin = vitePPDev(options);
    const server = {
      config: { base: '/', logger: { error: vi.fn(), info: vi.fn() } },
      middlewares: { use: vi.fn() },
      ws: {},
    } as unknown as ViteDevServer;
    const closeBundle = plugin.closeBundle as () => void;

    (plugin.configureServer as (server: ViteDevServer) => void)(server);
    closeBundle();
    closeBundle();

    expect(clientServiceDispose).toHaveBeenCalledTimes(1);
  });
});

describe('vitePPDev sync build timeout', () => {
  it('passes sync.buildTimeoutMs to DistService', () => {
    const options = normalizePPDevConfig(
      {
        app: { id: 123, type: 'template' },
        inspector: { enabled: false },
        mi: { url: 'https://mi.example.com' },
        proxy: { cache: false },
        sync: { buildTimeoutMs: 1_800_000 },
      },
      'test-app',
    );
    const plugin = vitePPDev(options);
    const server = {
      config: { base: '/', logger: { error: vi.fn(), info: vi.fn() } },
      middlewares: { use: vi.fn() },
      ws: {},
    } as unknown as ViteDevServer;

    (plugin.configureServer as (server: ViteDevServer) => void)(server);

    expect(distServiceConstructor).toHaveBeenLastCalledWith(
      'test-app',
      expect.objectContaining({ buildTimeoutMs: 1_800_000 }),
    );
  });
});
