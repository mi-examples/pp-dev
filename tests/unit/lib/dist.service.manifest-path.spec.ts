import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DistService } from '../../../src/lib/dist.service.js';

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function createBackup(manifestFiles: Record<string, string>, zipFiles: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  const checksum = sha256(
    Object.keys(manifestFiles)
      .sort()
      .map((filePath) => manifestFiles[filePath])
      .join(''),
  );

  for (const [filePath, content] of Object.entries(zipFiles)) {
    zip.file(filePath, content);
  }

  zip.file(
    'VERSION-v1.0.0-test.json',
    JSON.stringify({
      checksum,
      files: manifestFiles,
      schemaVersion: 1,
      version: 'v1.0.0',
    }),
  );

  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('DistService VERSION manifest paths', () => {
  let backupDir: string;

  beforeEach(() => {
    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-manifest-path-'));
  });

  afterEach(() => {
    fs.rmSync(backupDir, { force: true, recursive: true });
  });

  it('allows parent segments that normalize inside the backup root', async () => {
    const content = 'safe content';
    const backup = await createBackup({ 'nested/../safe.txt': sha256(content) }, { 'safe.txt': content });
    const analysis = await new DistService('test-app', { backupFolder: backupDir }).analyzeBackup(backup);

    expect(analysis.versionManifestHashMismatches).toEqual([]);
    expect(analysis.unknownFiles).toEqual([]);
  });

  it('rejects manifest paths that escape the backup root', async () => {
    const outsideFileName = `pp-dev-outside-${process.pid}-${Date.now()}.txt`;
    const outsideFilePath = path.join(os.tmpdir(), outsideFileName);
    const content = 'outside content';

    fs.writeFileSync(outsideFilePath, content);

    try {
      const backup = await createBackup({ [`../../${outsideFileName}`]: sha256(content) }, {});
      const service = new DistService('test-app', { backupFolder: backupDir });

      await expect(service.analyzeBackup(backup)).rejects.toThrow(/outside.*backup root/i);
    } finally {
      fs.rmSync(outsideFilePath, { force: true });
    }
  });
});
