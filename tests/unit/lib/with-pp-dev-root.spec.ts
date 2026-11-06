import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearConfigCache } from '../../../src/config.js';
import { withPPDev, type PPDevConfig } from '../../../src/index.js';
import { PP_DEV_PROJECT_ROOT_ENV_VAR } from '../../../src/constants.js';

/**
 * `pp-dev next <dir>` and `pp-dev next-build <dir>` resolve the project root they are given, but
 * Next evaluates `next.config` with no root to pass on, so `withPPDev()` read the package.json and
 * pp-dev config of the directory the command was run from: from a parent directory, "app.name is
 * required". The commands hand the root over in the environment.
 */
describe('withPPDev project root', () => {
  let projectRoot: string;
  let parentRoot: string;

  beforeAll(async () => {
    await import('next/constants.js');
  }, 60_000);

  beforeEach(() => {
    parentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-root-parent-'));
    projectRoot = path.join(parentRoot, 'app');
    fs.mkdirSync(projectRoot);
    fs.writeFileSync(
      path.join(parentRoot, 'package.json'),
      JSON.stringify({ name: 'parent-workspace', 'pp-dev': { mi: { url: 'https://parent.example.com' } } }),
    );
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'nested-app', 'pp-dev': { mi: { url: 'https://mi.example.com' } } }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(parentRoot);
    clearConfigCache();
  });

  afterEach(() => {
    delete process.env[PP_DEV_PROJECT_ROOT_ENV_VAR];
    vi.restoreAllMocks();
    clearConfigCache();
    fs.rmSync(parentRoot, { force: true, recursive: true });
  });

  async function ppDevOf(): Promise<PPDevConfig> {
    const result = await withPPDev({}, { app: { id: 7, type: 'template' } })('phase-development-server');

    return (result as { ppDev: PPDevConfig }).ppDev;
  }

  it('reads the root the command was given, not the directory it was run from', async () => {
    process.env[PP_DEV_PROJECT_ROOT_ENV_VAR] = projectRoot;

    const ppDev = await ppDevOf();

    expect(ppDev.mi).toEqual({ url: 'https://mi.example.com' });
  });

  it('falls back to the current directory without one', async () => {
    const ppDev = await ppDevOf();

    expect(ppDev.mi).toEqual({ url: 'https://parent.example.com' });
  });
});
