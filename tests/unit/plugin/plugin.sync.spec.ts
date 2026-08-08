import { describe, expect, it, vi } from 'vitest';
import type { ViteDevServer } from 'vite';

const distServiceConstructor = vi.hoisted(() => vi.fn());

vi.mock('../../../src/lib/dist.service.js', () => ({
  DistService: class {
    constructor(...args: unknown[]) {
      distServiceConstructor(...args);
    }
  },
}));

vi.mock('../../../src/lib/client.service.js', () => ({
  ClientService: class {},
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
