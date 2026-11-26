import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearConfigCache, findConfig, getConfig } from '../../../src/config.js';

/**
 * Whether a project has a standalone pp-dev config at all: `getConfig()` answers `{}` both for a
 * project without one and for an empty one, and a check that validated that answer refused every
 * config change of a project whose pp-dev config lives in `next.config` (`withPPDev()`).
 */
describe('findConfig', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-find-config-'));
    clearConfigCache();
  });

  afterEach(() => {
    clearConfigCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds a pp-dev.config file', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"file-app"}');
    fs.writeFileSync(path.join(root, 'pp-dev.config.mjs'), "export default { app: { id: 3, type: 'template' } };\n");

    await expect(findConfig(root)).resolves.toEqual({ config: { app: { id: 3, type: 'template' } }, found: true });
  });

  it("finds package.json's pp-dev", async () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"pkg-app","pp-dev":{"app":{"id":4,"type":"page"}}}');

    await expect(findConfig(root)).resolves.toEqual({ config: { app: { id: 4, type: 'page' } }, found: true });
  });

  // A file that exports nothing (null, a half-written save) or a package key of the wrong kind
  // counted as no config at all: the supervisor's check let the change through, stopped the
  // working server, and the new one refused the empty config.
  it('finds a config file whatever it exports', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"null-app"}');
    fs.writeFileSync(path.join(root, 'pp-dev.config.mjs'), 'export default null;\n');

    await expect(findConfig(root)).resolves.toEqual({ config: {}, found: true });
  });

  it("finds package.json's pp-dev whatever it holds", async () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"pkg-app","pp-dev":"oops"}');

    await expect(findConfig(root)).resolves.toEqual({ config: {}, found: true });
  });

  it('finds none in a project whose config lives in next.config', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"next-app"}');
    fs.writeFileSync(path.join(root, 'next.config.mjs'), 'export default {};\n');

    await expect(findConfig(root)).resolves.toEqual({ config: {}, found: false });
    await expect(getConfig(root)).resolves.toEqual({});
  });

  // `--pp-config <file>`: a config of another name or place (one per environment, a shared one).
  describe('a config named with --pp-config (PP_DEV_CONFIG)', () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(root, 'package.json'), '{"name":"named-app"}');
      fs.writeFileSync(path.join(root, 'pp-dev.config.mjs'), "export default { app: { id: 1, type: 'template' } };\n");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('loads that file in place of the one in the root', async () => {
      const file = path.join(root, 'configs', 'staging.config.ts');

      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, "const id: number = 2;\nexport default { app: { id, type: 'page' } };\n");
      vi.stubEnv('PP_DEV_CONFIG', file);

      await expect(findConfig(root)).resolves.toEqual({ config: { app: { id: 2, type: 'page' } }, found: true });
    });

    // Review of #402: the bundle was written into the project root, where the config's own
    // packages are not installed.
    it('resolves the packages a config elsewhere imports from beside it', async () => {
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-named-config-'));

      try {
        const pkg = path.join(elsewhere, 'node_modules', 'shared-pp-settings');

        fs.mkdirSync(pkg, { recursive: true });
        fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"shared-pp-settings","main":"index.js"}');
        fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = { appId: 8 };\n');

        const file = path.join(elsewhere, 'pp-dev.shared.config.cjs');

        fs.writeFileSync(
          file,
          "const { appId } = require('shared-pp-settings');\nmodule.exports = { app: { id: appId } };\n",
        );
        vi.stubEnv('PP_DEV_CONFIG', file);

        await expect(getConfig(root)).resolves.toEqual({ app: { id: 8 } });
        // The temporary bundle beside it is gone.
        expect(fs.readdirSync(elsewhere).sort()).toEqual(['node_modules', 'pp-dev.shared.config.cjs']);
      } finally {
        fs.rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    // Review of #402: a `.js` / `.ts` config was bundled in the format of the project's package.json,
    // so one from an ESM package with top-level await failed in a CommonJS project.
    it('bundles a config elsewhere in the module format of its own package', async () => {
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-named-config-'));

      try {
        fs.writeFileSync(path.join(elsewhere, 'package.json'), '{"name":"shared-configs","type":"module"}');

        const file = path.join(elsewhere, 'pp-dev.shared.config.ts');

        fs.writeFileSync(file, 'const id: number = await Promise.resolve(9);\nexport default { app: { id } };\n');
        vi.stubEnv('PP_DEV_CONFIG', file);

        await expect(getConfig(root)).resolves.toEqual({ app: { id: 9 } });
      } finally {
        fs.rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it('loads a JSON file', async () => {
      const file = path.join(root, 'pp.json');

      fs.writeFileSync(file, '{"app":{"id":5}}');
      vi.stubEnv('PP_DEV_CONFIG', file);

      await expect(getConfig(root)).resolves.toEqual({ app: { id: 5 } });
    });

    it('refuses a file that is not there, rather than starting without a config', async () => {
      vi.stubEnv('PP_DEV_CONFIG', path.join(root, 'missing.config.ts'));

      await expect(findConfig(root)).rejects.toThrow(
        `The pp-dev config ${path.join(root, 'missing.config.ts')} (--pp-config or PP_DEV_CONFIG) does not exist`,
      );
    });

    it('refuses a file of another kind', async () => {
      const file = path.join(root, 'config.yaml');

      fs.writeFileSync(file, 'app: {}');
      vi.stubEnv('PP_DEV_CONFIG', file);

      await expect(findConfig(root)).rejects.toThrow('must be a .js, .cjs, .mjs, .ts, .cts, .mts or .json file');
    });

    it('takes the one in the root again once none is named', async () => {
      vi.stubEnv('PP_DEV_CONFIG', '  ');

      await expect(getConfig(root)).resolves.toEqual({ app: { id: 1, type: 'template' } });
    });
  });
});
