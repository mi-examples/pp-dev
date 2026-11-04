import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Keeps package.json's `exports` and `files` in step with what the build produces.
 *
 * The `types` of `./plugin` and `./helpers` pointed at `dist/types/plugin.d.ts` and `helpers.d.ts`,
 * but the DTS build had one entry, `src/index.ts`, so the published `dist/types/` held one file and
 * users of those subpaths got TS7016. `files` listed `LICENSE.md` (the file is `LICENSE`) and an
 * `assets` folder that doesn't exist.
 */

const root = path.resolve(__dirname, '../../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as {
  types: string;
  exports: Record<string, string | { types?: string; import?: string; require?: string }>;
  files: string[];
};

/** The `types` targets of the subpath exports, relative to the package root. */
const typesTargets = Object.values(pkg.exports)
  .map((entry) => (typeof entry === 'object' ? entry.types : undefined))
  .filter((target): target is string => typeof target === 'string');

describe('package.json exports', () => {
  it('builds a declaration file for every subpath that promises one', async () => {
    const { default: dtsConfig } = (await import('../../../rollup.config.types.ts')) as {
      default: { input: Record<string, string>; output: { dir: string } };
    };
    const outDir = dtsConfig.output.dir;

    for (const target of typesTargets) {
      const name = path.basename(target, '.d.ts');

      expect(path.dirname(target).replace(/^\.\//, ''), target).toBe(outDir);
      expect(dtsConfig.input, `${target} needs an entry named "${name}" in rollup.config.types.ts`).toHaveProperty(
        name,
      );
    }

    expect(typesTargets).toContain(pkg.types.startsWith('./') ? pkg.types : `./${pkg.types}`);
  });

  // Only once the package is built (the e2e job in CI, or after `npm run build` locally).
  it.skipIf(!fs.existsSync(path.join(root, 'dist', 'types')))('has every promised declaration file in dist/', () => {
    for (const target of typesTargets) {
      expect(fs.existsSync(path.join(root, target)), target).toBe(true);
    }

    for (const [subpath, entry] of Object.entries(pkg.exports)) {
      if (typeof entry !== 'object') {
        continue;
      }

      for (const file of [entry.import, entry.require]) {
        expect(file && fs.existsSync(path.join(root, file)), `${subpath}: ${file}`).toBe(true);
      }
    }
  });
});

describe('package.json files', () => {
  it('lists only files and folders that exist', () => {
    for (const entry of pkg.files) {
      // `dist` is built, not checked in.
      if (entry === 'dist') {
        continue;
      }

      expect(fs.existsSync(path.join(root, entry)), entry).toBe(true);
    }
  });
});
