import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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

  // The commands pass Vite `configFile: false`, so this load is the only one: it must see the
  // config as Vite's own did — NODE_ENV defaulted for the command, isSsrBuild for `build --ssr`.
  describe('as Vite loaded the file', () => {
    let dir: string;
    let nodeEnv: string | undefined;

    beforeAll(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'pp-dev-vite-config-env-'));
      writeFileSync(
        path.join(dir, 'vite.config.mjs'),
        [
          'export default ({ isSsrBuild }) => ({',
          "  plugins: process.env.NODE_ENV === 'production' ? [{ name: 'production-only' }] : [{ name: 'other' }],",
          '  define: { __SSR__: JSON.stringify(isSsrBuild === true) },',
          '});',
          '',
        ].join('\n'),
      );
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    beforeEach(() => {
      nodeEnv = process.env.NODE_ENV;
      Reflect.deleteProperty(process.env, 'NODE_ENV');
    });

    afterEach(() => {
      if (nodeEnv === undefined) {
        Reflect.deleteProperty(process.env, 'NODE_ENV');
      } else {
        Object.assign(process.env, { NODE_ENV: nodeEnv });
      }
    });

    const load = (options: { command: 'build' | 'serve'; isPreview?: boolean; ssr?: boolean }) =>
      loadCommandViteConfig({ root: dir, mode: 'production', configFile: undefined, logLevel: 'silent', ...options });
    const pluginNames = (config: { plugins?: unknown[] }) =>
      (config.plugins ?? []).map((plugin) => (plugin as { name: string }).name);

    it.each([
      ['a build', { command: 'build' as const }, 'production-only'],
      ['a preview', { command: 'serve' as const, isPreview: true }, 'production-only'],
      ['the dev server', { command: 'serve' as const }, 'other'],
    ])('defaults NODE_ENV for %s while the file loads, and takes it back', async (_name, options, plugin) => {
      const { config } = await load(options);

      expect(pluginNames(config)).toContain(plugin);
      expect(process.env.NODE_ENV).toBeUndefined();
    });

    it('keeps a NODE_ENV that is set', async () => {
      Object.assign(process.env, { NODE_ENV: 'development' });

      const { config } = await load({ command: 'build' });

      expect(pluginNames(config)).toContain('other');
      expect(process.env.NODE_ENV).toBe('development');
    });

    // The default set for the load was taken back whatever the file did with it: a config that
    // sets NODE_ENV itself (`development` for a development-style build) lost it, and Vite, no
    // longer loading the file again, built for production.
    it('keeps a NODE_ENV the config file sets itself', async () => {
      const own = mkdtempSync(path.join(tmpdir(), 'pp-dev-vite-config-own-env-'));

      try {
        writeFileSync(
          path.join(own, 'vite.config.mjs'),
          ["process.env.NODE_ENV = 'development';", 'export default {};', ''].join('\n'),
        );

        await loadCommandViteConfig({
          root: own,
          mode: 'production',
          command: 'build',
          configFile: undefined,
          logLevel: 'silent',
        });

        expect(process.env.NODE_ENV).toBe('development');
      } finally {
        rmSync(own, { recursive: true, force: true });
      }
    });

    it('tells the file of an SSR build', async () => {
      expect(JSON.parse(String((await load({ command: 'build', ssr: true })).config.define?.__SSR__))).toBe(true);
      expect(JSON.parse(String((await load({ command: 'build' })).config.define?.__SSR__))).toBe(false);
    });
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
