import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ViteDevServer } from 'vite';

/** Every dev panel service made, in order, each with a `dispose` spy of its own. */
const clientServices = vi.hoisted(() => [] as Array<{ dispose: ReturnType<typeof vi.fn> }>);

vi.mock('../../../src/lib/client.service.js', () => ({
  ClientService: class {
    dispose = vi.fn();

    constructor() {
      clientServices.push(this);
    }
  },
}));

vi.mock('../../../src/lib/dist.service.js', () => ({ DistService: class {} }));

vi.mock('../../../src/lib/variables-editor.js', () => ({
  VARIABLES_EDITOR_PATH: '/@pp-dev/variables-editor',
  registerVariablesEditorRoutes: vi.fn(),
}));

const { createServer } = await import('vite');
const { normalizePPDevConfig, vitePPDev } = await import('../../../src/plugin.js');

/**
 * `pp-dev serve` passes the plugin to Vite inline, and Vite's own restart (the `r` shortcut, a change
 * of `vite.config.*`) reuses that same instance: it makes the new server first, then closes the old
 * one. The plugin disposed the service it had just made for the new server, so every sync after a
 * restart failed with "pp-dev build was stopped" (and a sync of the old server ran on, untouched).
 */
describe("vitePPDev across Vite's own restart", () => {
  let root: string;
  let server: ViteDevServer | undefined;

  afterEach(async () => {
    await server?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("disposes the closing server's dev panel service, and keeps the new server's", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-vite-restart-'));
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>app</title>');

    const plugin = vitePPDev(
      normalizePPDevConfig(
        {
          app: { id: 123, type: 'template' },
          inspector: { enabled: false },
          mi: { url: 'https://mi.example.com' },
          proxy: { cache: false },
        },
        'test-app',
      ),
    );

    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      base: '/pt/test-app/',
      server: { middlewareMode: true, hmr: false, watch: null },
      plugins: [plugin],
    });

    expect(clientServices).toHaveLength(1);

    await server.restart();

    expect(clientServices).toHaveLength(2);
    expect(clientServices[0].dispose).toHaveBeenCalledTimes(1);
    expect(clientServices[1].dispose).not.toHaveBeenCalled();

    await server.close();
    server = undefined;

    expect(clientServices[1].dispose).toHaveBeenCalledTimes(1);
  });
});
