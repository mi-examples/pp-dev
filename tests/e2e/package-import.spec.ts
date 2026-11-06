/**
 * The built package imported from `node -e` (a script, a REPL, a vm-based host): those define a
 * global `__filename` of `[eval]`, which the ESM build took for its own path and resolved the
 * package directory from, failing on `[eval]/../../../package.json`.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '../..');

function run(script: string) {
  return spawnSync(process.execPath, ['-e', script], {
    cwd: packageDir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 60_000,
  });
}

describe('the built package from node -e', () => {
  it('imports the ESM build', () => {
    const esm = pathToFileURL(path.join(packageDir, 'dist', 'esm', 'index.js')).href;
    const result = run(`import(${JSON.stringify(esm)}).then((m) => console.log(typeof m.withPPDev))`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('function');
  });

  it('requires the CJS build', () => {
    const cjs = path.join(packageDir, 'dist', 'cjs', 'index.js');
    const result = run(`console.log(typeof require(${JSON.stringify(cjs)}).withPPDev)`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('function');
  });
});
