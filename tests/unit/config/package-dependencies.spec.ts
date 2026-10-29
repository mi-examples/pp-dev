import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

/**
 * Keeps `dependencies` in step with what the package loads at run time.
 *
 * `deepmerge-ts` and `winston` stayed in `dependencies` after the code that used them was gone, and
 * `typescript` and `rollup` were there although only the build uses them, so every project that
 * installs pp-dev installed them too. Moving a package the code loads to `devDependencies` breaks
 * installs the other way round.
 *
 * The test bundles the package's entries with esbuild and collects every package they load: static
 * imports, `import()` and `require()` alike.
 */

const root = path.resolve(__dirname, '../../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as {
  dependencies: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

/** Dependencies pp-dev doesn't import itself, and why they still belong in `dependencies`. */
const NOT_IMPORTED: Record<string, string> = {
  // Optional peers of vite-plugin-image-optimizer, which pp-dev adds to every Vite build: it
  // optimizes raster images with sharp and SVGs with svgo only when they are installed.
  sharp: 'image optimizer peer',
  svgo: 'image optimizer peer',
  // Vite compiles a portal page's SCSS with it, and lists it only as an optional peer.
  sass: 'Vite SCSS compiler',
};

let loaded: Set<string>;

/** `@scope/name/sub/path` → `@scope/name`, `name/sub/path` → `name`. */
function packageName(specifier: string): string {
  const parts = specifier.split('/');

  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

beforeAll(async () => {
  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: ['src/index.ts', 'src/plugin.ts', 'src/cli.ts', 'src/helpers.ts'],
    bundle: true,
    write: false,
    metafile: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    outdir: 'out',
    logLevel: 'silent',
  });

  loaded = new Set(
    Object.values(result.metafile.inputs)
      .flatMap((input) => input.imports)
      // Packages only: not Node built-ins, nor files loaded by a path at run time.
      .filter((imported) => imported.external && !/^(?:node:|\.|\/|[a-z]:)/i.test(imported.path))
      .map((imported) => packageName(imported.path))
      .filter((name) => !builtinModules.includes(name)),
  );

  // esbuild doesn't see a package loaded through `createRequire(...)('name')`, as jsdom is.
  for (const file of Object.keys(result.metafile.inputs)) {
    const source = fs.readFileSync(path.join(root, file), 'utf-8');

    for (const [, specifier] of source.matchAll(/createRequire\([^)]*\)\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      loaded.add(packageName(specifier));
    }
  }
}, 30_000);

describe('package.json dependencies', () => {
  it('declares every package the code loads', () => {
    const declared = new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies ?? {})]);

    expect([...loaded].filter((name) => !declared.has(name)).sort()).toEqual([]);
  });

  it('lists only packages the code loads, or that it needs for another reason', () => {
    const unused = Object.keys(pkg.dependencies).filter((name) => !loaded.has(name) && !(name in NOT_IMPORTED));

    expect(unused.sort()).toEqual([]);
  });

  it('keeps the reasons for packages the code does not load up to date', () => {
    for (const name of Object.keys(NOT_IMPORTED)) {
      expect(pkg.dependencies, name).toHaveProperty(name);
      expect(loaded.has(name), `${name} is imported now, so it needs no reason`).toBe(false);
    }
  });
});
