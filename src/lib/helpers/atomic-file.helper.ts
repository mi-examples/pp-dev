import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';

/**
 * Writes `content` to `file` through a temporary file next to it, renamed over the old one: a crash
 * or a full disk never leaves half a file for whoever reads it next (the dev server serving it,
 * another dev server sharing the users file). The temporary file is removed when the write fails.
 */
export async function writeFileAtomic(
  file: string,
  content: string | Buffer,
  options?: { mode?: number },
): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;

  try {
    await fsp.writeFile(tmp, content, options);
    await fsp.rename(tmp, file);
  } catch (error) {
    await fsp.rm(tmp, { force: true });

    throw error;
  }
}

/** {@link writeFileAtomic} for callers that must not yield (the users file's change listener). */
export function writeFileAtomicSync(file: string, content: string | Buffer, options?: { mode?: number }): void {
  const tmp = `${file}.${process.pid}.tmp`;

  try {
    fs.writeFileSync(tmp, content, options);
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });

    throw error;
  }
}
