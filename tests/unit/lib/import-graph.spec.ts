import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import type { Metafile } from 'esbuild';

/**
 * Keeps heavy dependencies off the paths that only read the config.
 *
 * `withPPDev()` (src/index.ts) runs while Next.js evaluates next.config, for `next dev` and
 * `next build` alike, and the CLI loads its entry for every command, `--version` included. jsdom
 * (~1.2 s) and svgtofont (~0.9 s) were imported statically on both paths, and index.ts pulled in
 * the whole dev server (express, axios, the proxy) through plugin.ts.
 *
 * The test follows only static `import` statements from each entry in esbuild's metafile; a
 * dynamic `import()` or a `require()` call loads a package on use, which is the point.
 */

const root = path.resolve(__dirname, '../../..');
let metafile: Metafile;

beforeAll(async () => {
  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: ['src/index.ts', 'src/cli.ts', 'src/lib/pp-dev-config.ts'],
    bundle: true,
    write: false,
    metafile: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    outdir: 'out',
    logLevel: 'silent',
  });

  metafile = result.metafile;
});

/** The packages an entry loads through static imports alone. */
function staticPackages(entry: string): Set<string> {
  const packages = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop()!;

    if (seen.has(file)) {
      continue;
    }

    seen.add(file);

    for (const imported of metafile.inputs[file]?.imports ?? []) {
      if (imported.kind !== 'import-statement') {
        continue;
      }

      if (imported.external) {
        if (!imported.path.startsWith('node:')) {
          packages.add(
            imported.path.startsWith('@')
              ? imported.path.split('/').slice(0, 2).join('/')
              : imported.path.split('/')[0],
          );
        }
      } else {
        queue.push(imported.path);
      }
    }
  }

  return packages;
}

describe('static import graph', () => {
  it('reads the config (withPPDev in next.config) without loading the dev server, jsdom or svgtofont', () => {
    const packages = staticPackages('src/index.ts');

    for (const heavy of ['jsdom', 'svgtofont', 'express', 'axios', 'http-proxy-middleware', 'jszip', 'sharp']) {
      expect(packages, `src/index.ts loads ${heavy} statically`).not.toContain(heavy);
    }
  });

  it('starts the CLI without loading jsdom or svgtofont', () => {
    const packages = staticPackages('src/cli.ts');

    expect(packages).not.toContain('jsdom');
    expect(packages).not.toContain('svgtofont');
  });

  it('keeps the config module free of packages', () => {
    expect([...staticPackages('src/lib/pp-dev-config.ts')]).toEqual([]);
  });

  it('still finds static imports (guards the test itself)', () => {
    expect(staticPackages('src/cli.ts')).toContain('vite');
  });
});
