import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';
import { extractZipSafe, zipDirectoryToBuffer } from '../../../src/lib/helpers/zip.helper';

describe('extractZipSafe', () => {
  let tmp: string;
  let zipPath: string;
  let dest: string;

  const writeZip = async (zip: JSZip) => {
    await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
  };

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-dev-zip-'));
    zipPath = path.join(tmp, 'archive.zip');
    dest = path.join(tmp, 'out');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('extracts files and nested directories', async () => {
    const zip = new JSZip();

    zip.file('index.html', '<html></html>');
    zip.file('assets/js/app.js', 'console.log(1);');
    zip.folder('empty');
    await writeZip(zip);

    await extractZipSafe(zipPath, dest);

    expect(await fs.readFile(path.join(dest, 'index.html'), 'utf8')).toBe('<html></html>');
    expect(await fs.readFile(path.join(dest, 'assets/js/app.js'), 'utf8')).toBe('console.log(1);');
    expect((await fs.stat(path.join(dest, 'empty'))).isDirectory()).toBe(true);
  });

  it('round-trips an archive built by zipDirectoryToBuffer', async () => {
    const src = path.join(tmp, 'src');

    await fs.mkdir(path.join(src, 'sub'), { recursive: true });
    await fs.writeFile(path.join(src, 'a.txt'), 'A');
    await fs.writeFile(path.join(src, 'sub', 'b.txt'), 'B');
    await fs.writeFile(zipPath, await zipDirectoryToBuffer(src));

    await extractZipSafe(zipPath, dest);

    expect(await fs.readFile(path.join(dest, 'a.txt'), 'utf8')).toBe('A');
    expect(await fs.readFile(path.join(dest, 'sub', 'b.txt'), 'utf8')).toBe('B');
  });

  it('skips __MACOSX metadata entries', async () => {
    const zip = new JSZip();

    zip.file('a.txt', 'A');
    zip.file('__MACOSX/._a.txt', 'junk');
    await writeZip(zip);

    await extractZipSafe(zipPath, dest);

    expect(existsSync(path.join(dest, '__MACOSX'))).toBe(false);
  });

  it('rejects symlink entries without writing anything (GHSA-jmr9-qjv8-65gv)', async () => {
    const zip = new JSZip();

    zip.file('ok.txt', 'fine');
    zip.file('link', '/etc/passwd', { unixPermissions: 0o120777 });
    await writeZip(zip);

    await expect(extractZipSafe(zipPath, dest)).rejects.toThrow(/symlink/);
    expect(existsSync(dest)).toBe(false);
  });

  // The advisory's archive has a symlink entry and a same-named file entry after it. Symlinks are
  // rejected before any entry is written, so the follow-up write can never go through one.
  it('never writes outside the destination through a symlink entry (GHSA-7pqw-9j4j-h8q3)', async () => {
    const outside = path.join(tmp, 'outside.txt');
    const zip = new JSZip();

    zip.file('payload', outside, { unixPermissions: 0o120777 });
    zip.file('later/file.txt', 'written after the symlink');
    await writeZip(zip);

    await expect(extractZipSafe(zipPath, dest)).rejects.toThrow(/symlink/);
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });

  it('rejects entries that escape the destination via ..', async () => {
    const zip = new JSZip();

    zip.file('../escape.txt', 'pwned');
    await writeZip(zip);

    await expect(extractZipSafe(zipPath, dest)).rejects.toThrow(/outside the extraction directory/);
    expect(existsSync(path.join(tmp, 'escape.txt'))).toBe(false);
  });
});
