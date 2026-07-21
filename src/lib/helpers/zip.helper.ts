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
