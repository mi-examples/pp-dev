import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  // What Vite restarted on by itself, for pp-dev's watcher to take over: the config file and what
  // it imports, and the .env files of Vite's own envDir and mode.
  it("names the config file, what it imports, and Vite's .env files", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pp-dev-vite-config-deps-'));

    try {
      mkdirSync(path.join(dir, 'config'));
      writeFileSync(path.join(dir, 'config', 'helper.mjs'), 'export const envDir = "./config";\n');
      writeFileSync(
        path.join(dir, 'vite.config.mjs'),
        ["import { envDir } from './config/helper.mjs';", 'export default { envDir };', ''].join('\n'),
      );

      const { configFile, viteEnvFiles } = await loadCommandViteConfig({
        root: dir,
        mode: 'staging',
        command: 'serve',
        configFile: undefined,
        logLevel: 'silent',
      });

      expect(path.resolve(configFile?.path ?? '')).toBe(path.join(dir, 'vite.config.mjs'));
      expect(configFile?.dependencies.map((file) => path.resolve(file))).toContain(
        path.join(dir, 'config', 'helper.mjs'),
      );
      expect(viteEnvFiles).toEqual(
        ['.env', '.env.local', '.env.staging', '.env.staging.local'].map((name) => path.join(dir, 'config', name)),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The command's [root] is the inline config's, over the file's `root`: with `pp-dev .` and
  // `root: './web'` in the file, Vite loads the .env files of `.`, and those were not the ones named.
  it("names the .env files of the command's root over the file's", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pp-dev-vite-config-root-'));

    try {
      mkdirSync(path.join(dir, 'web'));
      writeFileSync(path.join(dir, 'vite.config.mjs'), "export default { root: './web' };\n");

      const { viteEnvFiles } = await loadCommandViteConfig({
        root: dir,
        mode: 'development',
        command: 'serve',
        configFile: undefined,
        logLevel: 'silent',
      });

      expect(viteEnvFiles[0]).toBe(path.join(dir, '.env'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names no .env files for envDir: false', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pp-dev-vite-config-noenv-'));

    try {
      writeFileSync(path.join(dir, 'vite.config.mjs'), 'export default { envDir: false };\n');

      const { viteEnvFiles } = await loadCommandViteConfig({
        root: dir,
        mode: 'development',
        command: 'serve',
        configFile: undefined,
        logLevel: 'silent',
      });

      expect(viteEnvFiles).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
