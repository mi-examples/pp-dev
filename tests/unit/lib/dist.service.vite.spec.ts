import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();

  return { ...actual, spawn: spawnMock };
});

const { DistService } = await import('../../../src/lib/dist.service.js');

describe('DistService — Vite in-memory sync archive', () => {
  let rootDir: string;
  let buildDir: string;
  let backupDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-vite-build-'));
    buildDir = path.join(rootDir, 'dist');
    backupDir = path.join(rootDir, 'backups');

    fs.mkdirSync(buildDir);
    fs.writeFileSync(path.join(buildDir, 'index.html'), '<html><body>app</body></html>');
    fs.mkdirSync(path.join(buildDir, 'assets'));
    fs.writeFileSync(path.join(buildDir, 'assets', 'app.js'), 'console.log(1)');

    spawnMock.mockImplementation(() => {
      const proc = new EventEmitter();

      setImmediate(() => proc.emit('close', 0));

      return proc;
    });
  });

  afterEach(() => {
    fs.rmSync(rootDir, { force: true, recursive: true });
    vi.clearAllMocks();
  });

  it('zips the build directory even when no persistent ZIP is configured', async () => {
    const service = new DistService('test-app', {
      backupFolder: backupDir,
      buildInputFolder: buildDir,
    });
    const buffer = await service.buildNewAssets();
    const zip = await JSZip.loadAsync(buffer);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(zip.file('index.html')).toBeTruthy();
    expect(zip.file('assets/app.js')).toBeTruthy();
  });
});
