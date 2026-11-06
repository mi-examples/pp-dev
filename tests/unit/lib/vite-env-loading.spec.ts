import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearConfigCache } from '../../../src/config.js';
import { getViteConfig } from '../../../src/index.js';

describe('getViteConfig environment loading', () => {
  let projectRoot: string;
  let originalBackendUrl: string | undefined;

  // getViteConfig() imports the whole dev server (plugin.js) on first use. Loaded here, outside the
  // test's own timeout: under a full parallel run on Windows that import alone can take over 10 s.
  beforeAll(async () => {
    await import('../../../src/plugin.js');
  }, 60_000);

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-env-'));
    originalBackendUrl = process.env.MI_BACKEND_URL;
    delete process.env.MI_BACKEND_URL;

    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({
        name: 'env-only-app',
        'pp-dev': {
          app: { id: 123, type: 'template' },
          build: { zip: false, versionFile: false },
        },
      }),
    );
    fs.writeFileSync(path.join(projectRoot, '.env'), 'MI_BACKEND_URL=https://env-only.example.com\n');
    vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    clearConfigCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearConfigCache();
    fs.rmSync(projectRoot, { force: true, recursive: true });

    if (originalBackendUrl === undefined) {
      delete process.env.MI_BACKEND_URL;
    } else {
      process.env.MI_BACKEND_URL = originalBackendUrl;
    }
  });

  it('loads MI_BACKEND_URL from .env before validating and normalizing config', async () => {
    const config = await getViteConfig();

    expect(config.ppDevConfig?.backendBaseURL).toBe('https://env-only.example.com');
  });
});
