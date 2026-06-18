import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import JSZip from 'jszip';

// Mock only child_process.spawn so `next build` is simulated (no real Next.js build),
// while keeping the rest (execSync used by version-manifest git lookup) intact.
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();

  return { ...actual, spawn: spawnMock };
});

const { DistService } = await import('../../../src/lib/dist.service.js');

describe('DistService — Next.js build strategy', () => {
  let exportDir: string;

  beforeEach(() => {
    exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-next-export-'));
    fs.writeFileSync(path.join(exportDir, 'index.html'), '<html><body>app</body></html>');
    fs.writeFileSync(path.join(exportDir, 'next.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    fs.mkdirSync(path.join(exportDir, 'sub'));
    fs.writeFileSync(path.join(exportDir, 'sub', 'app.js'), 'console.log(1)');
    fs.mkdirSync(path.join(exportDir, '_next', 'static', 'media'), { recursive: true });
    fs.writeFileSync(
      path.join(exportDir, '_next', 'static', 'media', 'next.0x5qb3h5j23ox.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1" /></svg>',
    );

    // Simulate a successful `next build`.
    spawnMock.mockImplementation(() => {
      const proc: any = new EventEmitter();

      setImmediate(() => proc.emit('close', 0));

      return proc;
    });
  });

  afterEach(() => {
    fs.rmSync(exportDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function createService() {
    return new DistService('test-app', {
      nextBuild: {
        // Resolve the `next` binary from the repo (next is a devDependency here).
        projectRoot: process.cwd(),
        distDir: exportDir,
        packageVersion: '1.2.3',
      },
    });
  }

  it('runs `next build` (not pp-dev build) and zips the export directory', async () => {
    const buf = await createService().buildNewAssets();

    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('build');
    expect(String(args[0])).toMatch(/next/);

    const zip = await JSZip.loadAsync(buf);

    expect(zip.file('index.html')).toBeTruthy();
    expect(zip.file('sub/app.js')).toBeTruthy();
  });

  it('includes VERSION and BUILD-MANIFEST files in the zip for sync parity', async () => {
    const buf = await createService().buildNewAssets();
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files);

    expect(names.some((n) => /^VERSION-v1\.2\.3-.*\.json$/.test(n))).toBe(true);
    expect(zip.file('BUILD-MANIFEST.json')).toBeTruthy();
  });

  it('produces a VERSION manifest whose hashes match the built files (round-trip)', async () => {
    const service = createService();
    const buf = await service.buildNewAssets();

    // Analyzing the freshly built zip must report no inconsistencies: the VERSION
    // file content (hashes) matches every built file, including SVGs.
    const analysis = await service.analyzeBackup(buf);

    expect(analysis.versionManifestHashMismatches).toEqual([]);
    expect(analysis.unknownFiles).toEqual([]);
    expect(analysis.buildManifestMismatch).toBeNull();
  });

  it('rejects when `next build` exits non-zero', async () => {
    spawnMock.mockImplementation(() => {
      const proc: any = new EventEmitter();

      setImmediate(() => proc.emit('close', 1));

      return proc;
    });

    await expect(createService().buildNewAssets()).rejects.toThrow(/next build exited with code 1/);
  });
});
