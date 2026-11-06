import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadCommandViteConfig } from '../../../src/cli/vite-config.js';

vi.mock('../../../src/index.js', () => ({
  getViteConfig: vi.fn(async () => ({})),
}));

/**
 * `pp-dev optimize` and `pp-dev preview` loaded the project's `vite.config.*` as for a build, while
 * Vite's own commands resolve both as `serve` (preview with `isPreview`): a config function that
 * goes by `command` saw the wrong one.
 */
describe('loadCommandViteConfig', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'pp-dev-vite-config-'));
    writeFileSync(
      path.join(root, 'vite.config.mjs'),
      [
        'export default ({ command, mode, isPreview }) => ({',
        '  define: { __SEEN__: JSON.stringify({ command, mode, isPreview: isPreview === true }) },',
        "  plugins: [{ name: 'from-the-file' }],",
        '});',
        '',
      ].join('\n'),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['a build', { command: 'build' as const }, { command: 'build', isPreview: false }],
    ['the dev server', { command: 'serve' as const }, { command: 'serve', isPreview: false }],
    ['a preview', { command: 'serve' as const, isPreview: true }, { command: 'serve', isPreview: true }],
  ])('shows a config function the command of %s', async (_name, options, seen) => {
    const { config } = await loadCommandViteConfig({
      root,
      mode: 'production',
      configFile: undefined,
      logLevel: 'silent',
      ...options,
    });

    expect(JSON.parse(String(config.define?.__SEEN__))).toEqual({ mode: 'production', ...seen });
  });

  // The file's plugins were left out, for Vite to load the file again (`configFile`): that merged
  // it under the inline config a second time, arrays doubled, and Vite restarted on its own when
  // the file changed. The commands pass `configFile: false` now, so the plugins come from here.
  it("keeps the file's plugins", async () => {
    const { config } = await loadCommandViteConfig({
      root,
      mode: 'production',
      command: 'serve',
      configFile: undefined,
      logLevel: 'silent',
    });

    expect((config.plugins ?? []).map((plugin) => (plugin as { name: string }).name)).toContain('from-the-file');
  });
});
