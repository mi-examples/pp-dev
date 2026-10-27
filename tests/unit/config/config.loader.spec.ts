import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Config Loader', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();

    testDir = join(tmpdir(), `pp-dev-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });

    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);

    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }

    vi.resetModules();
  });

  describe('getConfig', () => {
    it('should return empty config when no config files exist', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test' }));

      const { getConfig, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const config = await getConfig();

      expect(config).toEqual({});
    });

    it('should load grouped config from package.json pp-dev field', async () => {
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({
          name: 'test-project',
          'pp-dev': {
            mi: { url: 'https://pkg.example.com' },
            app: { id: 456 },
          },
        }),
      );

      const { getConfig, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const config = await getConfig();

      expect(config.mi?.url).toBe('https://pkg.example.com');
      expect(config.app?.id).toBe(456);
    });

    it('should load grouped config from pp-dev.config.json', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test' }));
      writeFileSync(
        join(testDir, 'pp-dev.config.json'),
        JSON.stringify({
          mi: { url: 'https://json.example.com' },
          app: { id: 111, type: 'page' },
        }),
      );

      const { getConfig, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const config = await getConfig();

      expect(config.mi?.url).toBe('https://json.example.com');
      expect(config.app?.id).toBe(111);
      expect(config.app?.type).toBe('page');
    });

    it('should prioritize config file over package.json pp-dev field', async () => {
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({
          name: 'test',
          'pp-dev': {
            mi: { url: 'https://pkg.example.com' },
            app: { id: 1 },
          },
        }),
      );
      writeFileSync(
        join(testDir, 'pp-dev.config.json'),
        JSON.stringify({
          mi: { url: 'https://file.example.com' },
          app: { id: 2 },
        }),
      );

      const { getConfig, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const config = await getConfig();

      expect(config.mi?.url).toBe('https://file.example.com');
      expect(config.app?.id).toBe(2);
    });

    it('should not load pp-watch.config.json (legacy format removed in 1.0)', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test' }));
      writeFileSync(
        join(testDir, '.pp-watch.config.json'),
        JSON.stringify({
          baseURL: 'https://watch.example.com',
          portalPageId: 789,
        }),
      );

      const { getConfig, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const config = await getConfig();

      // Legacy watch config is no longer loaded — result should be empty
      expect(config).toEqual({});
    });
  });

  describe('getPkg', () => {
    it('should return package.json contents', async () => {
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({
          name: 'test-package',
          version: '1.0.0',
          description: 'Test package',
        }),
      );

      const { getPkg, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const pkg = getPkg();

      expect(pkg.name).toBe('test-package');
      expect(pkg.version).toBe('1.0.0');
    });

    it('should return empty object when package.json does not exist', async () => {
      const { getPkg, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const pkg = getPkg();

      expect(pkg).toEqual({});
    });
  });

  describe('explicit project root', () => {
    it('loads config and package metadata from the requested project instead of cwd', async () => {
      const projectRoot = join(testDir, 'apps', 'target-app');

      mkdirSync(projectRoot, { recursive: true });
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({
          name: 'workspace-root',
          'pp-dev': { mi: { url: 'https://workspace.example.com' } },
        }),
      );
      writeFileSync(
        join(projectRoot, 'package.json'),
        JSON.stringify({
          name: 'target-app',
          'pp-dev': { mi: { url: 'https://target.example.com' } },
        }),
      );

      const { getConfig, getPkg, clearConfigCache } = await import('../../../src/config.js');

      clearConfigCache();

      const workspaceConfig = await getConfig();
      const workspacePkg = getPkg();
      const config = await getConfig(projectRoot);
      const pkg = getPkg(projectRoot);

      expect(workspaceConfig.mi?.url).toBe('https://workspace.example.com');
      expect(workspacePkg.name).toBe('workspace-root');
      expect(config.mi?.url).toBe('https://target.example.com');
      expect(pkg.name).toBe('target-app');
    });
  });

  /**
   * Regression tests for "the config watcher restarts the server with the old config". A JS
   * config was imported from its own path, which Node caches for the life of the process, so
   * `clearConfigCache()` + restart read the stale module. And a `.cts` config in an ESM project
   * (or an `.mts` one in a CommonJS project) failed to load: it was compiled into a `.js` file
   * read by the project's package.json `type`.
   */
  describe('reading a changed config again', () => {
    // esbuild runs a long-lived service process, started in the cwd of its first call. Started
    // from a test's temporary folder, it would keep Windows from deleting that folder. beforeAll
    // runs before the outer beforeEach switches to that folder.
    beforeAll(async () => {
      const esbuild = await import('esbuild');

      await esbuild.transform('');
    });

    async function loadAfterEdit(
      pkg: Record<string, unknown>,
      fileName: string,
      source: (url: string) => string,
      extraFiles: (url: string) => Record<string, string> = () => ({}),
      editedFile = fileName,
    ) {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test', ...pkg }));

      const write = (url: string) => {
        const files = { [fileName]: source(url), ...extraFiles(url) };

        for (const [name, content] of Object.entries(files)) {
          if (name === editedFile || url === 'https://before.example.com') {
            writeFileSync(join(testDir, name), content);
          }
        }
      };

      const { getConfig, clearConfigCache } = await import('../../../src/config.js');

      write('https://before.example.com');
      clearConfigCache();

      const before = await getConfig();

      write('https://after.example.com');
      clearConfigCache();

      const after = await getConfig();

      return { before: before.mi?.url, after: after.mi?.url };
    }

    it.each([
      ['an .mjs config', {}, 'pp-dev.config.mjs', (url: string) => `export default { mi: { url: '${url}' } };`],
      ['a .cjs config', {}, 'pp-dev.config.cjs', (url: string) => `module.exports = { mi: { url: '${url}' } };`],
      [
        'a .js config in an ESM project',
        { type: 'module' },
        'pp-dev.config.js',
        (url: string) => `export default { mi: { url: '${url}' } };`,
      ],
      [
        'a .js config in a CommonJS project',
        { type: 'commonjs' },
        'pp-dev.config.js',
        (url: string) => `module.exports = { mi: { url: '${url}' } };`,
      ],
      [
        'a .ts config',
        { type: 'module' },
        'pp-dev.config.ts',
        (url: string) => `const url: string = '${url}';\nexport default { mi: { url } };`,
      ],
    ])('reads %s again after it changed', async (_name, pkg, fileName, source) => {
      expect(await loadAfterEdit(pkg, fileName, source)).toEqual({
        before: 'https://before.example.com',
        after: 'https://after.example.com',
      });
    });

    it('reads a changed file that the config imports', async () => {
      const result = await loadAfterEdit(
        { type: 'module' },
        'pp-dev.config.js',
        () => `import { url } from './mi-url.js';\nexport default { mi: { url } };`,
        (url) => ({ 'mi-url.js': `export const url = '${url}';` }),
        'mi-url.js',
      );

      expect(result).toEqual({ before: 'https://before.example.com', after: 'https://after.example.com' });
    });

    it.each([
      ['a .cts config in an ESM project', { type: 'module' }, 'pp-dev.config.cts'],
      ['an .mts config in a CommonJS project', { type: 'commonjs' }, 'pp-dev.config.mts'],
    ])('loads %s', async (_name, pkg, fileName) => {
      const result = await loadAfterEdit(
        pkg,
        fileName,
        (url) => `const url: string = '${url}';\nexport default { mi: { url } };`,
      );

      expect(result).toEqual({ before: 'https://before.example.com', after: 'https://after.example.com' });
    });

    it('resolves paths in the config from its own folder', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test', type: 'module' }));
      writeFileSync(
        join(testDir, 'pp-dev.config.js'),
        `import { fileURLToPath } from 'node:url';\nexport default { build: { outDir: fileURLToPath(new URL('./out', import.meta.url)) } };`,
      );

      const { getConfig, clearConfigCache } = await import('../../../src/config.js');

      clearConfigCache();

      const config = (await getConfig()) as { build?: { outDir?: string } };

      expect(config.build?.outDir).toBe(join(realpathSync(testDir), 'out'));
    });

    it('resolves module-relative paths in the files a config imports from their own folders', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test', type: 'module' }));
      mkdirSync(join(testDir, 'settings'));
      writeFileSync(
        join(testDir, 'settings', 'paths.mjs'),
        [
          `import { fileURLToPath } from 'node:url';`,
          `export const out = fileURLToPath(new URL('./out', import.meta.url));`,
          `export const dir = import.meta.dirname;`,
          `export const file = import.meta.filename;`,
        ].join('\n'),
      );
      writeFileSync(
        join(testDir, 'settings', 'legacy.cjs'),
        `module.exports = { dir: __dirname, file: __filename };`,
      );
      writeFileSync(
        join(testDir, 'pp-dev.config.mjs'),
        [
          `import { out, dir, file } from './settings/paths.mjs';`,
          `import legacy from './settings/legacy.cjs';`,
          `export default { paths: { out, dir, file, legacy, configDir: import.meta.dirname } };`,
        ].join('\n'),
      );

      const { getConfig, clearConfigCache } = await import('../../../src/config.js');

      clearConfigCache();

      const { paths } = (await getConfig()) as { paths: Record<string, unknown> };
      const root = process.cwd();
      const settings = join(root, 'settings');

      expect(paths).toEqual({
        out: join(settings, 'out'),
        dir: settings,
        file: join(settings, 'paths.mjs'),
        legacy: { dir: settings, file: join(settings, 'legacy.cjs') },
        configDir: root,
      });
    });

    it("loads a CommonJS file that requires Node built-ins and packages into an ESM config, next to the config's own require", async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test', type: 'module' }));
      mkdirSync(join(testDir, 'node_modules', 'local-pkg'), { recursive: true });
      writeFileSync(join(testDir, 'node_modules', 'local-pkg', 'index.js'), `module.exports = 'from a package';`);
      writeFileSync(
        join(testDir, 'node_modules', 'local-pkg', 'package.json'),
        JSON.stringify({ name: 'local-pkg', main: 'index.js' }),
      );
      writeFileSync(
        join(testDir, 'helper.cjs'),
        `const fs = require('node:fs');\nmodule.exports = { fs: typeof fs.readFileSync, pkg: require('local-pkg') };`,
      );
      writeFileSync(
        join(testDir, 'pp-dev.config.mjs'),
        [
          `import { createRequire } from 'node:module';`,
          `import helper from './helper.cjs';`,
          `const require = createRequire(import.meta.url);`,
          `export default { helper, own: typeof require('node:path').join };`,
        ].join('\n'),
      );

      const { getConfig, clearConfigCache } = await import('../../../src/config.js');

      clearConfigCache();

      expect(await getConfig()).toEqual({ helper: { fs: 'function', pkg: 'from a package' }, own: 'function' });
    });

    it('leaves no temporary files behind', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test' }));
      writeFileSync(join(testDir, 'pp-dev.config.mjs'), `export default { mi: { url: 'https://example.com' } };`);

      const { getConfig, clearConfigCache } = await import('../../../src/config.js');

      clearConfigCache();
      await getConfig();

      expect(readdirSync(testDir).filter((name) => name.startsWith('pp-config.timestamp-'))).toEqual([]);
    });
  });

  describe('Config Caching', () => {
    it('should cache package.json reads', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0' }));

      const { getPkg, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const pkg1 = getPkg();
      const pkg2 = getPkg();

      expect(pkg1).toBe(pkg2); // same cached reference on second call
    });

    it('should clear cache when clearConfigCache is called', async () => {
      const { getPkg, clearConfigCache } = await import('../../../src/config.js');

      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'before-clear' }));
      clearConfigCache();
      expect(getPkg().name).toBe('before-clear');

      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'after-clear' }));
      clearConfigCache();
      expect(getPkg().name).toBe('after-clear');
    });
  });
});
