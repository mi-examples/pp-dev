import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();

  return { ...actual, spawn: spawnMock };
});

const { DistService, TEMPLATE_VARIABLES_FILE_NAME } = await import('../../../src/lib/dist.service.js');
const { createLogger } = await import('../../../src/lib/logger.js');

describe('DistService — root-scoped path resolution', () => {
  let projectRoot: string;
  let unrelatedCwd: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-root-project-'));
    unrelatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-root-cwd-'));

    // Simulate the dev server's cwd differing from the resolved Vite project root.
    process.chdir(unrelatedCwd);

    spawnMock.mockImplementation(() => {
      const proc = new EventEmitter();

      setImmediate(() => proc.emit('close', 0));

      return proc;
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(projectRoot, { force: true, recursive: true });
    fs.rmSync(unrelatedCwd, { force: true, recursive: true });
    vi.clearAllMocks();
  });

  it('resolves relative build/backup/zip folders against the explicit root, not process.cwd()', async () => {
    const buildDir = path.join(projectRoot, 'dist');

    fs.mkdirSync(buildDir);
    fs.writeFileSync(path.join(buildDir, 'index.html'), '<html></html>');

    const service = new DistService('test-app', {
      root: projectRoot,
      metaDir: '.pp-dev-meta',
      buildInputFolder: 'dist',
    });

    const buffer = await service.buildNewAssets();

    expect(buffer.byteLength).toBeGreaterThan(0);
    expect(spawnMock).toHaveBeenCalledWith(
      'node',
      expect.anything(),
      expect.objectContaining({ cwd: projectRoot }),
    );
  });

  // stopBuilds replaced its AbortController, so a sync still fetching assets when the server closed
  // got a fresh signal and built (and uploaded) afterwards.
  it('refuses every build once stopped, also one a sync starts later', async () => {
    const service = new DistService('test-app', {
      root: projectRoot,
      metaDir: '.pp-dev-meta',
      buildInputFolder: 'dist',
    });

    service.stopBuilds();

    await expect(service.buildNewAssets()).rejects.toThrow('pp-dev build was stopped');
    await expect(service.buildNewAssets()).rejects.toThrow('pp-dev build was stopped');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // A server stopped while the finished build was being zipped still got assets to upload.
  it('returns no assets when stopped right after the build', async () => {
    fs.mkdirSync(path.join(projectRoot, 'dist'));
    fs.writeFileSync(path.join(projectRoot, 'dist', 'index.html'), '<html></html>');

    const service = new DistService('test-app', {
      root: projectRoot,
      metaDir: '.pp-dev-meta',
      buildInputFolder: 'dist',
    });
    const info = vi.spyOn(createLogger(), 'info').mockImplementation((message: string) => {
      if (String(message).includes('Build finished')) {
        service.stopBuilds();
      }
    });

    try {
      await expect(service.buildNewAssets()).rejects.toThrow('pp-dev build was stopped');
    } finally {
      info.mockRestore();
    }
  });

  // "Build finished" was logged for a stopped or failed build too.
  it('logs how a build ended', async () => {
    const info = vi.spyOn(createLogger(), 'info');
    const ended = () =>
      info.mock.calls.map(([message]) => String(message)).filter((m) => /Build (finished|failed|stopped)/.test(m));

    fs.mkdirSync(path.join(projectRoot, 'dist'));

    const service = new DistService('test-app', {
      root: projectRoot,
      metaDir: '.pp-dev-meta',
      buildInputFolder: 'dist',
    });

    await service.buildNewAssets();
    expect(ended().at(-1)).toContain('Build finished');

    spawnMock.mockImplementationOnce(() => {
      const proc = new EventEmitter();

      setImmediate(() => proc.emit('close', 1));

      return proc;
    });
    await expect(service.buildNewAssets()).rejects.toThrow('exited with code 1');
    expect(ended().at(-1)).toContain('Build failed');

    service.stopBuilds();
    await expect(service.buildNewAssets()).rejects.toThrow('was stopped');
    expect(ended().at(-1)).toContain('Build stopped');

    info.mockRestore();
  });

  it('reads and writes the template variables file under the explicit root', async () => {
    const service = new DistService('test-app', { root: projectRoot, metaDir: '.pp-dev-meta' });

    await service.saveTemplateVariablesFile(Buffer.from('{"a":1}', 'utf-8'));

    expect(fs.existsSync(path.join(projectRoot, 'public', TEMPLATE_VARIABLES_FILE_NAME))).toBe(true);
    expect(fs.existsSync(path.join(unrelatedCwd, 'public', TEMPLATE_VARIABLES_FILE_NAME))).toBe(false);

    const readBack = await service.readPublicTemplateVariablesFile();

    expect(readBack?.toString('utf-8')).toBe('{"a":1}');
  });

  it('resolves an explicit relative backupFolder against the explicit root, not process.cwd()', async () => {
    // eslint-disable-next-line no-new -- the constructor's fire-and-forget syncMeta() creates the folder
    new DistService('test-app', {
      root: projectRoot,
      metaDir: '.pp-dev-meta',
      backupFolder: 'backups',
    });

    // Don't call checkMeta() ourselves: the constructor already kicked one off in the
    // background (unawaited), and a second concurrent call races its mkdir. Poll instead.
    await vi.waitFor(() => {
      expect(fs.existsSync(path.join(projectRoot, 'backups'))).toBe(true);
    });

    expect(fs.existsSync(path.join(unrelatedCwd, 'backups'))).toBe(false);
  });

  it('defaults root to process.cwd() when not provided', async () => {
    const service = new DistService('test-app', { metaDir: '.pp-dev-meta' });

    await service.saveTemplateVariablesFile(Buffer.from('{}', 'utf-8'));

    expect(fs.existsSync(path.join(unrelatedCwd, 'public', TEMPLATE_VARIABLES_FILE_NAME))).toBe(true);
  });
});
