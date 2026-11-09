import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearConfigCache } from '../../../src/config.js';
import { getViteConfig } from '../../../src/index.js';

/** Under `pp-dev` Vite checks Host itself, so `server.allowedHosts` from the pp-dev config goes to Vite. */
describe('getViteConfig server.allowedHosts', () => {
  let projectRoot: string;

  // getViteConfig() imports the whole dev server (plugin.js) on first use. Loaded here, outside the
  // test's own timeout: under a full parallel run on Windows that import alone can take over 10 s.
  beforeAll(async () => {
    await import('../../../src/plugin.js');
  }, 60_000);

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-hosts-'));
    vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    clearConfigCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearConfigCache();
    fs.rmSync(projectRoot, { force: true, recursive: true });
  });

  function writeConfig(server?: object) {
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({
        name: 'hosts-app',
        'pp-dev': {
          mi: { url: 'https://mi.example.com' },
          app: { id: 123, type: 'template' },
          build: { zip: false, versionFile: false },
          ...(server ? { server } : {}),
        },
      }),
    );
  }

  it('passes the hosts to Vite', async () => {
    writeConfig({ allowedHosts: ['My-App.ngrok.app', '.trycloudflare.com'] });

    expect((await getViteConfig()).server?.allowedHosts).toEqual(['my-app.ngrok.app', '.trycloudflare.com']);
  });

  it('passes true to Vite', async () => {
    writeConfig({ allowedHosts: true });

    expect((await getViteConfig()).server?.allowedHosts).toBe(true);
  });

  it("leaves Vite's default without any", async () => {
    writeConfig();

    expect((await getViteConfig()).server).not.toHaveProperty('allowedHosts');
  });
});
