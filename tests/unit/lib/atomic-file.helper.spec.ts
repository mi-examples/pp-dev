import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic, writeFileAtomicSync } from '../../../src/lib/helpers/atomic-file.helper.js';

/**
 * Files the dev server serves or shares (`public/__template_variables.json`, the users file) are
 * written through a temporary file renamed over the old one: a write that fails halfway used to
 * leave a truncated `__template_variables.json` for the dev server to serve.
 */
describe('writeFileAtomic', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-atomic-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replaces the file and leaves no temporary file behind', async () => {
    const file = path.join(dir, 'data.json');

    fs.writeFileSync(file, 'old');
    await writeFileAtomic(file, 'new');

    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(fs.readdirSync(dir)).toEqual(['data.json']);
  });

  it('keeps what was there and removes the temporary file when the write cannot finish', async () => {
    // A directory where the file should go: the rename over it fails, as a full disk would.
    const taken = path.join(dir, 'taken');

    fs.mkdirSync(taken);

    await expect(writeFileAtomic(taken, 'new')).rejects.toThrow();

    expect(fs.readdirSync(dir)).toEqual(['taken']);
  });

  // Writes of one file at a time (two editor saves, a save during a sync) shared one temporary
  // file: the second write went into the file the first was renaming, and the second rename failed
  // on a file that was gone. Each has its own now, and they go one after the other: two renames over
  // one file at once fail on Windows for the one that loses.
  it('takes overlapping writes of one file in order, the last one asked for staying', async () => {
    const file = path.join(dir, 'schema.json');
    const contents = Array.from({ length: 10 }, (_, i) => String(i).repeat(100_000));

    await Promise.all(contents.map((content) => writeFileAtomic(file, content)));

    expect(fs.readFileSync(file, 'utf8')).toBe(contents[9]);
    expect(fs.readdirSync(dir)).toEqual(['schema.json']);
  });

  it('goes on with the next write of a file after one that failed', async () => {
    const taken = path.join(dir, 'taken');

    fs.mkdirSync(taken);

    const failed = writeFileAtomic(taken, 'x');
    const next = writeFileAtomic(taken, 'y');

    await expect(failed).rejects.toThrow();
    // The queued write is past its wait but not at its rename yet: its temporary file is being
    // written on the thread pool, which only completes after this turn.
    fs.rmdirSync(taken);
    await next;

    expect(fs.readFileSync(taken, 'utf8')).toBe('y');
  });

  it('does the same synchronously', () => {
    const file = path.join(dir, 'users.json');
    const taken = path.join(dir, 'taken');

    writeFileAtomicSync(file, 'one', { mode: 0o600 });
    writeFileAtomicSync(file, 'two');
    fs.mkdirSync(taken);

    expect(fs.readFileSync(file, 'utf8')).toBe('two');
    expect(() => writeFileAtomicSync(taken, 'x')).toThrow();
    expect(fs.readdirSync(dir).sort()).toEqual(['taken', 'users.json']);
  });
});
