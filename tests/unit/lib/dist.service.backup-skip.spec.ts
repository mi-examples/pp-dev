import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DistService } from '../../../src/lib/dist.service.js';
import { zipFromEntries } from '../helpers/zip.js';

/**
 * A backup is saved whenever MI's assets differ from the last backup. They were compared by the
 * VERSION checksum alone when every file was listed there: that is the checksum of the last build,
 * which a page edited in MI keeps, so the one backup that mattered (of the edit, before the sync
 * overwrote it) was the one skipped. A file VERSION doesn't list went into the fingerprint as a
 * placeholder, so a change to such a file was skipped the same way.
 */

const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');

/**
 * A backup as MI holds it: a VERSION file from the build (`built` is what each listed file held
 * then), and the files themselves as they are now (`files`: edited in MI, or added there).
 */
function backup(built: Record<string, string>, files: Record<string, string>): Promise<Buffer> {
  const hashes = Object.fromEntries(Object.entries(built).map(([name, content]) => [name, sha256(content)]));
  const checksum = sha256(
    Object.keys(hashes)
      .sort()
      .map((name) => hashes[name])
      .join(''),
  );

  return zipFromEntries({
    ...files,
    'VERSION-v1.0.0-test.json': JSON.stringify({ checksum, files: hashes, schemaVersion: 1, version: 'v1.0.0' }),
  });
}

describe('DistService#saveBackup — what counts as a change', () => {
  let root: string;
  let service: DistService;
  let saves = 0;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-backup-skip-'));
    saves = 0;
    // One name per save: the default date format (to the second) gives two saves in a row one name.
    service = new DistService('page', {
      root,
      backupFolder: 'backups',
      metaDir: '.meta',
      dateFormat: () => String(++saves),
    });
  });

  afterEach(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  const savedBackups = () => fs.readdirSync(path.join(root, 'backups')).filter((name) => name.endsWith('.zip'));

  it('saves a backup of a listed file edited in MI, though VERSION is the one of the last backup', async () => {
    await service.saveBackup(await backup({ 'index.html': 'built' }, { 'index.html': 'built' }));

    const edited = await backup({ 'index.html': 'built' }, { 'index.html': 'edited in MI' });
    const analysis = await service.analyzeBackup(edited);

    expect(analysis.versionManifestHashMismatches).toEqual([
      { relativePath: 'index.html', expected: sha256('built'), actual: sha256('edited in MI') },
    ]);

    await service.saveBackup(edited, analysis);

    expect(savedBackups()).toHaveLength(2);
    expect(service.getBackupMeta()).not.toHaveProperty('lastMainHash');
  });

  it('saves a backup when a file VERSION does not list changed', async () => {
    await service.saveBackup(await backup({ 'index.html': 'built' }, { 'index.html': 'built', 'notes.txt': 'one' }));

    const changed = await backup({ 'index.html': 'built' }, { 'index.html': 'built', 'notes.txt': 'two' });
    const analysis = await service.analyzeBackup(changed);

    expect(analysis.unknownFiles).toEqual(['notes.txt']);
    expect(analysis.versionManifestHashMismatches).toEqual([]);

    await service.saveBackup(changed, analysis);

    expect(savedBackups()).toHaveLength(2);
  });

  it('still skips a backup of the same files, listed in VERSION or not', async () => {
    const same = () => backup({ 'index.html': 'built' }, { 'index.html': 'built', 'notes.txt': 'one' });

    await service.saveBackup(await same());
    await service.saveBackup(await same());

    expect(savedBackups()).toHaveLength(1);
  });
});
