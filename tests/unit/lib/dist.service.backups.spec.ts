import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DistService,
  DEFAULT_MAX_BACKUPS,
  backupNamePattern,
  type BackupAnalysis,
} from '../../../src/lib/dist.service.js';

/**
 * Regression tests for DistService's start-up and backups:
 *
 * - the constructor started reading the sync meta without awaiting it, so a failure became an
 *   unhandled rejection and a sync started meanwhile dereferenced a meta that was still `null`;
 * - the meta and backups folders were created without `recursive`, so `sync.backupsDir:
 *   '.pp-dev/backups'` failed with ENOENT when `.pp-dev` didn't exist yet;
 * - nothing ever deleted a backup: every sync with changed content added another full ZIP.
 */

const analysis = (fingerprint: string) =>
  ({ backupFingerprint: fingerprint, mainHash: null, allFilesInMeta: false }) as unknown as BackupAnalysis;

describe('DistService — start-up and backups', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-backups-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { force: true, recursive: true });
  });

  /** Keeps the sync meta in memory: its real file is shared by everything in this process. */
  function memoryMeta(initial: object = {}, readDelayMs = 0) {
    let stored = JSON.stringify(initial);

    vi.spyOn(DistService.prototype, 'readMetaFile').mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(stored), readDelayMs)),
    );
    vi.spyOn(DistService.prototype, 'writeMetaFile').mockImplementation(async (meta) => {
      stored = JSON.stringify(meta);
    });

    return () => JSON.parse(stored);
  }

  function writeBackup(dir: string, name: string, ageMinutes: number) {
    const file = path.join(dir, name);
    const time = new Date(Date.now() - ageMinutes * 60_000);

    fs.writeFileSync(file, 'zip');
    fs.utimesSync(file, time, time);
  }

  it('creates a backups folder whose parent does not exist yet', async () => {
    const service = new DistService('page', { root, metaDir: '.pp-dev-meta', backupFolder: '.pp-dev/backups' });

    await service.checkMeta();

    expect(fs.statSync(path.join(root, '.pp-dev', 'backups')).isDirectory()).toBe(true);
  });

  // The meta was kept two folders above the package files: with pnpm that is the shared store, so
  // every project on the same pp-dev version read and wrote one meta (and with `npm link`, the
  // global prefix). It now lives with the project's backups.
  it("keeps the sync meta in the project's backups folder by default", async () => {
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-backups-other-'));

    try {
      const service = new DistService('page', { root, backupFolder: '.pp-dev/backups' });
      const other = new DistService('page', { root: otherRoot, backupFolder: '.pp-dev/backups' });

      await service.saveBackup(Buffer.from('zip'), analysis('mine'));
      await other.syncMeta();

      const metaFile = path.join(root, '.pp-dev', 'backups', '.pp-dev-meta', 'sync-service.meta.json');

      expect(JSON.parse(fs.readFileSync(metaFile, 'utf-8'))).toMatchObject({
        lastBackupName: service.getBackupMeta()!.lastBackupName,
      });
      expect(other.getBackupMeta()).toEqual({});
      expect(fs.existsSync(path.join(otherRoot, '.pp-dev', 'backups', '.pp-dev-meta', 'sync-service.meta.json'))).toBe(
        true,
      );
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('leaves the meta folder alone when it prunes the backups next to it', async () => {
    const service = new DistService('page', { root, backupFolder: 'backups', maxBackups: 1 });

    await service.saveBackup(Buffer.from('one'), analysis('one'));
    await service.saveBackup(Buffer.from('two'), analysis('two'));

    expect(fs.readdirSync(path.join(root, 'backups')).sort()).toEqual(
      ['.pp-dev-meta', service.getBackupMeta()!.lastBackupName].sort(),
    );
  });

  it('keeps the sync meta in the given folder, relative to the root or absolute', async () => {
    const relative = new DistService('page', { root, metaDir: 'state/meta', backupFolder: 'backups' });

    await relative.syncMeta();

    expect(fs.existsSync(path.join(root, 'state', 'meta', 'sync-service.meta.json'))).toBe(true);

    const absoluteDir = path.join(root, 'elsewhere');
    const absolute = new DistService('page', { root, metaDir: absoluteDir, backupFolder: 'backups' });

    await absolute.syncMeta();

    expect(fs.readdirSync(absoluteDir)).toEqual(['sync-service.meta.json']);
  });

  it('waits for the sync meta before using it', async () => {
    memoryMeta({ lastBackupName: 'page-old.zip' }, 20);
    fs.writeFileSync(path.join(root, 'page-old.zip'), 'zip');

    const service = new DistService('page', { root, metaDir: '.pp-dev-meta', backupFolder: '.' });

    // Called right away, while the meta file is still being read.
    await expect(service.getLatestSavedBackup()).resolves.toBe(path.join(root, 'page-old.zip'));
  });

  it('starts with an empty meta when the meta file cannot be read, without an unhandled rejection', async () => {
    vi.spyOn(DistService.prototype, 'readMetaFile').mockRejectedValue(new Error('EACCES: permission denied'));
    vi.spyOn(DistService.prototype, 'writeMetaFile').mockResolvedValue(undefined);

    const service = new DistService('page', { root, metaDir: '.pp-dev-meta', backupFolder: '.' });

    await expect(service.getLatestSavedBackup()).resolves.toBeNull();
    expect(service.getBackupMeta()).toEqual({});
  });

  it("deletes this page's oldest backups beyond maxBackups and leaves other files alone", async () => {
    const backups = path.join(root, 'backups');

    fs.mkdirSync(backups);
    memoryMeta();

    for (const [index, age] of [50, 40, 30, 20, 10].entries()) {
      writeBackup(backups, `page-2026-10-0${index + 1}T10-00-00.zip`, age);
    }

    writeBackup(backups, 'other-page-2026-10-01T10-00-00.zip', 60);
    // Pages whose names start with this one's, and a ZIP that only shares the prefix.
    writeBackup(backups, 'page-admin-2026-10-01T10-00-00.zip', 60);
    writeBackup(backups, 'page-v2-2026-10-01T10-00-00.zip', 60);
    writeBackup(backups, 'page-notes.zip', 60);
    writeBackup(backups, 'notes.txt', 60);

    const service = new DistService('page', { root, metaDir: '.pp-dev-meta', backupFolder: 'backups', maxBackups: 3 });

    await service.saveBackup(Buffer.from('new zip'), analysis('new'));

    const saved = service.getBackupMeta()!.lastBackupName;

    expect(fs.readdirSync(backups).sort()).toEqual(
      [
        'notes.txt',
        'other-page-2026-10-01T10-00-00.zip',
        'page-admin-2026-10-01T10-00-00.zip',
        'page-v2-2026-10-01T10-00-00.zip',
        'page-notes.zip',
        'page-2026-10-04T10-00-00.zip',
        'page-2026-10-05T10-00-00.zip',
        saved,
      ].sort(),
    );
  });

  it('keeps every backup with maxBackups: false', async () => {
    const backups = path.join(root, 'backups');

    fs.mkdirSync(backups);
    memoryMeta();

    for (let index = 0; index < 4; index += 1) {
      writeBackup(backups, `page-2026-10-0${index + 1}T10-00-00.zip`, 50 - index);
    }

    const service = new DistService('page', {
      root,
      metaDir: '.pp-dev-meta',
      backupFolder: 'backups',
      maxBackups: false,
    });

    await service.saveBackup(Buffer.from('new zip'), analysis('new'));

    expect(fs.readdirSync(backups)).toHaveLength(5);
  });

  it(`keeps ${DEFAULT_MAX_BACKUPS} backups by default`, async () => {
    const backups = path.join(root, 'backups');

    fs.mkdirSync(backups);
    memoryMeta();

    for (let index = 0; index < DEFAULT_MAX_BACKUPS + 5; index += 1) {
      writeBackup(backups, `page-2026-09-${String(index + 1).padStart(2, '0')}T10-00-00.zip`, 100 - index);
    }

    const service = new DistService('page', { root, metaDir: '.pp-dev-meta', backupFolder: 'backups' });

    await service.saveBackup(Buffer.from('new zip'), analysis('new'));

    expect(fs.readdirSync(backups)).toHaveLength(DEFAULT_MAX_BACKUPS);
  });

  it('keeps the limit when an old backup is dated after the new one (skewed clock)', async () => {
    const backups = path.join(root, 'backups');

    fs.mkdirSync(backups);
    memoryMeta();
    // An hour in the future: sorted by time, it comes before the backup about to be saved.
    writeBackup(backups, 'page-2026-10-01T10-00-00.zip', -60);
    writeBackup(backups, 'page-2026-10-02T10-00-00.zip', 10);

    const service = new DistService('page', { root, metaDir: '.pp-dev-meta', backupFolder: 'backups', maxBackups: 1 });

    await service.saveBackup(Buffer.from('new zip'), analysis('new'));

    expect(fs.readdirSync(backups)).toEqual([service.getBackupMeta()!.lastBackupName]);
  });

  it('saves the backup even when old ones cannot be listed', async () => {
    const backups = path.join(root, 'backups');

    fs.mkdirSync(backups);
    memoryMeta();

    const service = new DistService('page', { root, metaDir: '.pp-dev-meta', backupFolder: 'backups', maxBackups: 1 });

    vi.spyOn(fs.promises, 'readdir').mockRejectedValueOnce(new Error('EPERM'));

    await expect(service.saveBackup(Buffer.from('new zip'), analysis('new'))).resolves.toBeUndefined();
    expect(fs.readdirSync(backups)).toEqual([service.getBackupMeta()!.lastBackupName]);
  });
});

describe('backupNamePattern', () => {
  const defaultDate = '2026-10-27T10-00-00';
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-backup-names-'));
  });

  afterAll(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  it('matches the default template for this page only', () => {
    const pattern = backupNamePattern('{pageName}-{date}.zip', 'my.page', defaultDate);

    expect(pattern.test('my.page-2026-10-27T10-00-00.zip')).toBe(true);
    expect(pattern.test('my.page-2025-01-02T03-04-05.zip')).toBe(true);
    expect(pattern.test('myXpage-2026-10-27T10-00-00.zip')).toBe(false);
    expect(pattern.test('other-2026-10-27T10-00-00.zip')).toBe(false);
    expect(pattern.test('my.page-2026-10-27T10-00-00.zip.bak')).toBe(false);
  });

  it("doesn't match pages whose names start with this one's, or ZIPs that only share the prefix", () => {
    const pattern = backupNamePattern('{pageName}-{date}.zip', 'page', defaultDate);

    expect(pattern.test('page-admin-2026-10-26T14-00-00.zip')).toBe(false);
    expect(pattern.test('page-v2-2026-10-26T14-00-00.zip')).toBe(false);
    expect(pattern.test('page-2-2026-10-26T14-00-00.zip')).toBe(false);
    expect(pattern.test('page-notes.zip')).toBe(false);
    expect(pattern.test('page-.zip')).toBe(false);
  });

  it('matches a custom template and date format, with or without a date', () => {
    expect(backupNamePattern('backup_{date}_{pageName}.zip', 'p', '20261027').test('backup_20251231_p.zip')).toBe(true);
    expect(backupNamePattern('backup_{date}_{pageName}.zip', 'p', '20261027').test('backup_x_p.zip')).toBe(false);
    expect(backupNamePattern('{pageName}.zip', 'p', defaultDate).test('p.zip')).toBe(true);
    expect(backupNamePattern('{pageName}.zip', 'p', defaultDate).test('p2.zip')).toBe(false);
  });

  // backupName() replaces only the first of each placeholder; the pattern has to agree with it.
  it.each([
    '{pageName}-{date}.zip',
    '{pageName}-{date}-{date}.zip',
    '{pageName}-{pageName}-{date}.zip',
    '{date}/{pageName}-{date}.zip',
    'backup.zip',
  ])('matches the names backupName() gives with template %s, and nothing shorter', async (template) => {
    const service = new DistService('p', { root, metaDir: '.pp-dev-meta', backupNameTemplate: template });
    const dateFormat = (date: Date) => date.toISOString().replace(/:/g, '-').replace(/\..*$/, '');
    const pattern = backupNamePattern(template, 'p', dateFormat(new Date('2026-10-27T10:00:00Z')));
    const name = service.backupName('p', new Date('2025-01-02T03:04:05Z'));

    expect(pattern.test(name)).toBe(true);
    expect(pattern.test(name.slice(0, -4))).toBe(false);

    // The constructor reads the meta (and creates its folders) in the background: done before
    // afterAll removes the root, or a late mkdir recreates it, or rmSync meets a folder being made.
    await service.getLatestSavedBackup();
  });

  it("doesn't take a repeated placeholder for a second one", () => {
    expect(backupNamePattern('{pageName}-{date}-{date}.zip', 'p', defaultDate).test('p-2026-10-27T10-00-00-.zip')).toBe(
      false,
    );
    expect(
      backupNamePattern('{pageName}-{pageName}-{date}.zip', 'p', defaultDate).test('p-p-2026-10-27T10-00-00.zip'),
    ).toBe(false);
  });
});
