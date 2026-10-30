import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearConfigCache } from '../../../src/config.js';
import { withPPDev, type PPDevConfig } from '../../../src/index.js';

/**
 * withPPDev() merges the file config, the Next config's `ppDev` and its own argument group by
 * group, field by field. A group left out of that merge was replaced whole: `server: {}` in the
 * argument dropped the file's `server.allowedHosts`, `users: {}` its `users.persist`.
 */
describe('withPPDev config merge', () => {
  let projectRoot: string;

  // withPPDev() imports Next on first use; loaded here, outside the tests' own timeout.
  beforeAll(async () => {
    await import('next/constants.js');
  }, 60_000);

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-merge-'));
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({
        name: 'merge-app',
        'pp-dev': {
          mi: { url: 'https://mi.example.com' },
          app: { id: 7, type: 'template' },
          server: { allowedHosts: ['my-app.ngrok.app'] },
          users: { persist: true },
        },
      }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    clearConfigCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearConfigCache();
    fs.rmSync(projectRoot, { force: true, recursive: true });
  });

  async function mergedPPDev(argument: PPDevConfig): Promise<PPDevConfig> {
    const result = await withPPDev({}, argument)('phase-development-server');

    return (result as { ppDev: PPDevConfig }).ppDev;
  }

  it('keeps the file config’s server and users fields that the argument does not set', async () => {
    const ppDev = await mergedPPDev({ server: {}, users: {} });

    expect(ppDev.server).toEqual({ allowedHosts: ['my-app.ngrok.app'] });
    expect(ppDev.users).toEqual({ persist: true });
  });

  it('lets the argument override them field by field', async () => {
    const ppDev = await mergedPPDev({ server: { allowedHosts: ['other.ngrok.app'] }, users: { persist: false } });

    expect(ppDev.server).toEqual({ allowedHosts: ['other.ngrok.app'] });
    expect(ppDev.users).toEqual({ persist: false });
  });

  // Next refuses its dev resources (HMR) to pages on other hosts unless allowedDevOrigins names
  // them, and reads that from this config: a tunnel in server.allowedHosts got "Unauthorized".
  it("adds the exact server.allowedHosts to Next's allowedDevOrigins in development", async () => {
    const result = await withPPDev(
      { allowedDevOrigins: ['other.lan'] },
      { server: { allowedHosts: ['my-app.ngrok.app', '.trycloudflare.com'] } },
    )('phase-development-server');

    expect(result.allowedDevOrigins).toEqual(['other.lan', 'my-app.ngrok.app']);
  });

  it('leaves allowedDevOrigins alone outside development', async () => {
    const result = await withPPDev({ allowedDevOrigins: ['other.lan'] })('phase-production-build');

    expect(result.allowedDevOrigins).toEqual(['other.lan']);
  });
});
