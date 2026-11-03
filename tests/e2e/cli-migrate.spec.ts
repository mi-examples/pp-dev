/**
 * `pp-dev migrate --dry-run` through the built CLI (`bin/pp-dev.js` → `dist/esm/cli.js`), as a
 * user runs it. The migrated config was printed with `console.log`, which the build's minifier
 * dropped as a "pure" call: the command printed its header and no config at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bin = path.resolve(__dirname, '../../bin/pp-dev.js');

describe('pp-dev migrate --dry-run', () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-migrate-'));
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'legacy-page', version: '1.0.0' }));
    fs.writeFileSync(
      path.join(projectDir, 'pp-watch.config.json'),
      JSON.stringify({ baseURL: 'https://mi.example.com', portalPageId: 42 }),
    );
  });

  afterAll(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('prints the migrated config', () => {
    const result = spawnSync(process.execPath, [bin, 'migrate', '--dry-run'], {
      cwd: projectDir,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 60_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('dry-run');
    expect(result.stdout).toContain('https://mi.example.com');
    expect(result.stdout).toContain('42');
    // Nothing was written.
    expect(fs.readdirSync(projectDir).sort()).toEqual(['package.json', 'pp-watch.config.json']);
  });
});
