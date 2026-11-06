import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, normalizePath, type ViteDevServer } from 'vite';
import { takeViteEnvFiles, viteEnvFilesOf } from '../../../src/cli/vite-config.js';

/**
 * `pp-dev` keeps Vite from restarting on its own `.env` files (it restarted with the config and
 * plugin instances of the start) and gives them to its own watcher. The list known before the
 * server exists can miss them: a `mode` the config file sets when the command gives none, an
 * `envDir` a plugin's config hook sets. They are taken from the server as it resolved them.
 */
describe("a Vite dev server's own .env files", () => {
  let root: string;
  let server: ViteDevServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("are those of its resolved mode and envDir, and leave its watcher for pp-dev's", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-vite-env-'));
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'config', '.env'), 'VITE_A=1\n');

    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      mode: 'staging',
      server: { middlewareMode: true, hmr: false },
      plugins: [{ name: 'env-dir', config: () => ({ envDir: 'config' }) }],
    });

    const unwatch = vi.spyOn(server.watcher, 'unwatch');
    const files = takeViteEnvFiles(server);
    const expected = ['.env', '.env.local', '.env.staging', '.env.staging.local'].map((name) =>
      normalizePath(path.join(root, 'config', name)),
    );

    expect(files.map((file) => path.resolve(file))).toEqual(expected.map((file) => path.resolve(file)));
    expect(unwatch).toHaveBeenCalledWith(files);
  });

  it('are none for envDir: false', () => {
    expect(viteEnvFilesOf({ mode: 'development', envDir: false })).toEqual([]);
  });
});
