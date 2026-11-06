import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createConfigWatcher, type ConfigWatcher } from '../../../src/cli/config-watcher.js';

/**
 * Regression tests for the config file watcher, against a real directory.
 *
 * - It watched the config files by path, and chokidar drops a path that doesn't exist when the
 *   watch starts: a `.env.local` or config file created later, or a removed one, never restarted
 *   the server.
 * - A change during a restart was lost: the restart callback returned early while one was running
 *   (`isRestarting`), and a restart takes seconds while the debounce is 500 ms, so a second save
 *   (format-on-save) left the first save's config running.
 * - The debounce timer was never cleared on cleanup: a save right before Ctrl-C started a new
 *   server during the shutdown.
 */

const DEBOUNCE_MS = 50;
const watchers: ConfigWatcher[] = [];
const dirs: string[] = [];

function makeProject(files: Record<string, string> = { 'pp-dev.config.ts': 'export default {};\n' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-config-watcher-'));

  dirs.push(dir);

  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }

  return dir;
}

async function startWatcher(dir: string, restart: () => Promise<void>, options: { mode?: string } = {}) {
  const logs: string[] = [];
  const watcher = createConfigWatcher(dir, restart, (message) => logs.push(message), {
    debounceMs: DEBOUNCE_MS,
    ...options,
  });

  watchers.push(watcher);
  await watcher.ready;

  return { watcher, logs };
}

const settle = (ms = DEBOUNCE_MS * 6) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  for (const watcher of watchers.splice(0)) {
    await watcher.close();
  }

  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('createConfigWatcher', () => {
  // "Config file watcher started" was logged on creation, before chokidar had looked at the
  // directory: a save right after it (the E2E suites do that) was never seen.
  it('reports that it started once a change right after is seen', async () => {
    const dir = makeProject();
    const restart = vi.fn().mockResolvedValue(undefined);
    const logs: string[] = [];
    const watcher = createConfigWatcher(dir, restart, (message) => logs.push(message), { debounceMs: DEBOUNCE_MS });

    watchers.push(watcher);

    expect(logs).toEqual([]);

    await watcher.ready;

    expect(logs.some((line) => line.includes('Config file watcher started'))).toBe(true);

    fs.appendFileSync(path.join(dir, 'pp-dev.config.ts'), '// right after ready\n');

    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });

  it('restarts once after a change to a config file', async () => {
    const dir = makeProject();
    const restart = vi.fn().mockResolvedValue(undefined);
    const { logs } = await startWatcher(dir, restart);

    fs.appendFileSync(path.join(dir, 'pp-dev.config.ts'), '// edited\n');

    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await settle();

    expect(restart).toHaveBeenCalledTimes(1);
    expect(logs.some((line) => line.includes('Config file changed: pp-dev.config.ts'))).toBe(true);
  });

  it.each(['.env.local', '.pp-dev.config.json', 'next.config.mjs'])(
    'restarts when %s is created after the watch started',
    async (name) => {
      const dir = makeProject();
      const restart = vi.fn().mockResolvedValue(undefined);
      const { logs } = await startWatcher(dir, restart);

      fs.writeFileSync(path.join(dir, name), name.endsWith('.json') ? '{}\n' : 'MI_URL=http://localhost\n');

      await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1), { timeout: 5000 });
      expect(logs.some((line) => line.includes(`Config file added: ${name}`))).toBe(true);
    },
  );

  it('restarts when a config file is removed', async () => {
    const dir = makeProject({ 'pp-dev.config.ts': 'export default {};\n', '.env': 'MI_URL=http://localhost\n' });
    const restart = vi.fn().mockResolvedValue(undefined);
    const { logs } = await startWatcher(dir, restart);

    fs.rmSync(path.join(dir, '.env'));

    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(logs.some((line) => line.includes('Config file removed: .env'))).toBe(true);
  });

  // The names were a fixed list: `next.config.mts` (Next 16), `vite.config.cts`/`.mts` and the
  // `.env.<mode>` files of a `--mode` other than development never restarted the server.
  it('watches the .env files of the mode, and every config extension', async () => {
    const dir = makeProject({ 'next.config.mts': 'export default {};\n', '.env.staging': 'MI_A=1\n' });
    const restart = vi.fn().mockResolvedValue(undefined);

    await startWatcher(dir, restart, { mode: 'staging' });

    fs.appendFileSync(path.join(dir, '.env.staging'), 'MI_B=2\n');
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1), { timeout: 5000 });

    fs.appendFileSync(path.join(dir, 'next.config.mts'), '// changed\n');
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(2), { timeout: 5000 });

    fs.writeFileSync(path.join(dir, '.env.development'), 'MI_C=3\n');
    await settle();

    expect(restart).toHaveBeenCalledTimes(2);
  });

  it('ignores other files and files in subdirectories', async () => {
    const dir = makeProject();
    const restart = vi.fn().mockResolvedValue(undefined);

    fs.mkdirSync(path.join(dir, 'src'));
    await startWatcher(dir, restart);

    fs.writeFileSync(path.join(dir, 'README.md'), '# app\n');
    fs.writeFileSync(path.join(dir, 'src', 'pp-dev.config.ts'), 'export default {};\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'dist\n');

    await settle();

    expect(restart).not.toHaveBeenCalled();
  });

  it('runs one more restart after the one a change came in during', async () => {
    const dir = makeProject();
    let finishFirst!: () => void;
    const restart = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finishFirst = resolve)))
      .mockResolvedValue(undefined);
    const { logs } = await startWatcher(dir, restart);

    fs.appendFileSync(path.join(dir, 'pp-dev.config.ts'), '// first save\n');
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1), { timeout: 5000 });

    // Two more saves while the first restart is still running: one restart afterwards, not two.
    fs.appendFileSync(path.join(dir, 'pp-dev.config.ts'), '// second save\n');
    await settle(DEBOUNCE_MS * 3);
    fs.appendFileSync(path.join(dir, 'pp-dev.config.ts'), '// third save\n');
    await settle(DEBOUNCE_MS * 3);

    expect(restart).toHaveBeenCalledTimes(1);

    finishFirst();

    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await settle();

    expect(restart).toHaveBeenCalledTimes(2);
    expect(logs.some((line) => line.includes('Config changed again during the restart'))).toBe(true);
  });

  it('drops a scheduled restart when closed', async () => {
    const dir = makeProject();
    const restart = vi.fn().mockResolvedValue(undefined);
    const { watcher } = await startWatcher(dir, restart);

    fs.appendFileSync(path.join(dir, 'pp-dev.config.ts'), '// edited\n');
    // The change event itself may take a moment; the restart waits for the debounce after it.
    await settle(DEBOUNCE_MS / 2);
    await watcher.close();
    await settle();

    expect(restart).not.toHaveBeenCalled();
  });

  it('logs a failed restart and keeps watching', async () => {
    const dir = makeProject();
    const restart = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('config is broken'))
      .mockResolvedValue(undefined);
    const { logs } = await startWatcher(dir, restart);

    fs.appendFileSync(path.join(dir, 'pp-dev.config.ts'), '// broken\n');
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await vi.waitFor(() => expect(logs.some((line) => line.includes('config is broken'))).toBe(true));

    fs.appendFileSync(path.join(dir, 'pp-dev.config.ts'), '// fixed\n');
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(2), { timeout: 5000 });
  });
});
