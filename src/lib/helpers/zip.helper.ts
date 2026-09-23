import * as path from 'path';
import { promises as fs } from 'fs';
import JSZip from 'jszip';

/** Zip a directory's contents (paths relative to `dir`) into an in-memory Buffer. */
export async function zipDirectoryToBuffer(dir: string): Promise<Buffer> {
  const zip = new JSZip();

  const addDir = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        await addDir(full);
      } else if (entry.isFile()) {
        const relativePath = path.relative(dir, full).replace(/\\/g, '/');

        zip.file(relativePath, await fs.readFile(full));
      }
    }
  };

  await addDir(dir);

  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/**
 * Extract a zip archive into `dir`, validating every entry before anything is written.
 *
 * Replaces extract-zip, whose symlink handling is unpatched (GHSA-jmr9-qjv8-65gv,
 * GHSA-7pqw-9j4j-h8q3): a symlink entry could point outside the destination, and a later entry
 * with the same name would be written through it. Here symlink entries are rejected outright and
 * every entry path must resolve inside `dir`, so nothing is ever written outside it.
 */
export async function extractZipSafe(zipPath: string, dir: string): Promise<void> {
  const zip = await JSZip.loadAsync(await fs.readFile(zipPath), { createFolders: false });
  const root = path.resolve(dir);
  const entries = Object.values(zip.files).filter((entry) => !entry.name.startsWith('__MACOSX/'));

  // Validate the whole archive first, so a bad entry never leaves a partial extraction behind.
  for (const entry of entries) {
    const rawName = entry.unsafeOriginalName ?? entry.name;
    const dest = path.resolve(root, rawName);

    if (dest !== root && !dest.startsWith(root + path.sep)) {
      throw new Error(`Zip entry "${rawName}" resolves outside the extraction directory`);
    }

    if (typeof entry.unixPermissions === 'number' && (entry.unixPermissions & S_IFMT) === S_IFLNK) {
      throw new Error(`Zip archive contains a symlink ("${rawName}"), which is not allowed`);
    }
  }

  await fs.mkdir(root, { recursive: true });

  for (const entry of entries) {
    const dest = path.resolve(root, entry.unsafeOriginalName ?? entry.name);

    if (entry.dir) {
      await fs.mkdir(dest, { recursive: true });
      continue;
    }

    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, await entry.async('nodebuffer'));
  }
}
