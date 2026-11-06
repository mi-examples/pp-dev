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
