import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    const service = new DistService('page', { root, backupFolder: '.pp-dev/backups' });

    await service.checkMeta();

    expect(fs.statSync(path.join(root, '.pp-dev', 'backups')).isDirectory()).toBe(true);
  });

  it('waits for the sync meta before using it', async () => {
    memoryMeta({ lastBackupName: 'page-old.zip' }, 20);
    fs.writeFileSync(path.join(root, 'page-old.zip'), 'zip');

    const service = new DistService('page', { root, backupFolder: '.' });

    // Called right away, while the meta file is still being read.
    await expect(service.getLatestSavedBackup()).resolves.toBe(path.join(root, 'page-old.zip'));
  });

  it('starts with an empty meta when the meta file cannot be read, without an unhandled rejection', async () => {
    vi.spyOn(DistService.prototype, 'readMetaFile').mockRejectedValue(new Error('EACCES: permission denied'));
    vi.spyOn(DistService.prototype, 'writeMetaFile').mockResolvedValue(undefined);

    const service = new DistService('page', { root, backupFolder: '.' });

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
    writeBackup(backups, 'notes.txt', 60);

    const service = new DistService('page', { root, backupFolder: 'backups', maxBackups: 3 });

    await service.saveBackup(Buffer.from('new zip'), analysis('new'));

    const saved = service.getBackupMeta()!.lastBackupName;

    expect(fs.readdirSync(backups).sort()).toEqual(
      [
        'notes.txt',
        'other-page-2026-10-01T10-00-00.zip',
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

    const service = new DistService('page', { root, backupFolder: 'backups', maxBackups: false });

    await service.saveBackup(Buffer.from('new zip'), analysis('new'));

    expect(fs.readdirSync(backups)).toHaveLength(5);
  });

  it(`keeps ${DEFAULT_MAX_BACKUPS} backups by default`, async () => {
    const backups = path.join(root, 'backups');

    fs.mkdirSync(backups);
    memoryMeta();

    for (let index = 0; index < DEFAULT_MAX_BACKUPS + 5; index += 1) {
      writeBackup(backups, `page-old-${String(index).padStart(2, '0')}.zip`, 100 - index);
    }

    const service = new DistService('page', { root, backupFolder: 'backups' });

    await service.saveBackup(Buffer.from('new zip'), analysis('new'));

    expect(fs.readdirSync(backups)).toHaveLength(DEFAULT_MAX_BACKUPS);
  });

  it('saves the backup even when old ones cannot be listed', async () => {
    const backups = path.join(root, 'backups');

    fs.mkdirSync(backups);
    memoryMeta();

    const service = new DistService('page', { root, backupFolder: 'backups', maxBackups: 1 });

    vi.spyOn(fs.promises, 'readdir').mockRejectedValueOnce(new Error('EPERM'));

    await expect(service.saveBackup(Buffer.from('new zip'), analysis('new'))).resolves.toBeUndefined();
    expect(fs.readdirSync(backups)).toEqual([service.getBackupMeta()!.lastBackupName]);
  });
});

describe('backupNamePattern', () => {
  it('matches the default template for this page only', () => {
    const pattern = backupNamePattern('{pageName}-{date}.zip', 'my.page');

    expect(pattern.test('my.page-2026-10-27T10-00-00.zip')).toBe(true);
    expect(pattern.test('myXpage-2026-10-27T10-00-00.zip')).toBe(false);
    expect(pattern.test('other-2026-10-27T10-00-00.zip')).toBe(false);
    expect(pattern.test('my.page-2026-10-27T10-00-00.zip.bak')).toBe(false);
  });

  it('matches a custom template, with or without a date', () => {
    expect(backupNamePattern('backup_{date}_{pageName}.zip', 'p').test('backup_20261027_p.zip')).toBe(true);
    expect(backupNamePattern('{pageName}.zip', 'p').test('p.zip')).toBe(true);
    expect(backupNamePattern('{pageName}.zip', 'p').test('p2.zip')).toBe(false);
  });
});
