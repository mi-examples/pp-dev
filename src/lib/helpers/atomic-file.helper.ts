import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

/**
 * A temporary file of its own for each write: two writes of one file at a time (two editor saves,
 * a save during a sync) shared one in this process, and one's rename failed on the other's.
 */
function temporaryFileFor(file: string): string {
  return `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

/** The write of each file under way in this process, for the next one of that file to wait for. */
const writes = new Map<string, Promise<void>>();

async function writeOnce(file: string, content: string | Buffer, options?: { mode?: number }): Promise<void> {
  const tmp = temporaryFileFor(file);

  try {
    await fsp.writeFile(tmp, content, options);
    await fsp.rename(tmp, file);
  } catch (error) {
    await fsp.rm(tmp, { force: true });

    throw error;
  }
}

/**
 * Writes `content` to `file` through a temporary file next to it, renamed over the old one: a crash
 * or a full disk never leaves half a file for whoever reads it next (the dev server serving it,
 * another dev server sharing the users file). The temporary file is removed when the write fails.
 *
 * Writes of one file go one after the other, in the order they were asked for: two renames over
 * one file at a time fail on Windows (EPERM for the one that loses), and the last write asked for
 * is the one that stays.
 */
export function writeFileAtomic(file: string, content: string | Buffer, options?: { mode?: number }): Promise<void> {
  const previous = writes.get(file) ?? Promise.resolve();
  const write = previous.then(
    () => writeOnce(file, content, options),
    () => writeOnce(file, content, options),
  );
  const done = () => {
    if (writes.get(file) === write) {
      writes.delete(file);
    }
  };

  writes.set(file, write);
  write.then(done, done);

  return write;
}

/** {@link writeFileAtomic} for callers that must not yield (the users file's change listener). */
export function writeFileAtomicSync(file: string, content: string | Buffer, options?: { mode?: number }): void {
  const tmp = temporaryFileFor(file);

  try {
    fs.writeFileSync(tmp, content, options);
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });

    throw error;
  }
}
