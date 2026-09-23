import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';
import * as process from 'process';
import { createRequire } from 'module';
import { PP_DEV_NEXT_BUILD_ENV_VAR } from '../constants.js';

/**
 * Remove dev-server route types that `next build` would otherwise type-check as a duplicate.
 *
 * tsconfig includes both `<distDir>/types` and `<distDir>/dev/types`, and `next build` drops the
 * dev ones from the program — but it looks for them under the *build* distDir. With
 * `output: 'export'` and a custom `distDir` (our Next templates use `distDir: 'dist'`), Next builds
 * into `.next` and only exports into `dist`, so it filters `.next/dev/types` while `next dev` wrote
 * `dist/dev/types`. Both copies of the global `validator.ts` then end up in one program and the
 * build fails with "Duplicate identifier 'PagesPageConfig'" after any dev session.
 *
 * Only generated files are removed; the dev server regenerates them on its next start.
 *
 * @returns the removed directory, or null when nothing needed removing
 */
export function removeStaleDevTypes(
  projectRoot: string,
  nextConfig: { output?: string; distDir?: string } | undefined,
): string | null {
  const distDir = nextConfig?.distDir;

  // Same condition as Next's hasCustomExportOutput(): only then do the build and dev dirs diverge.
  if (nextConfig?.output !== 'export' || !distDir || distDir === '.next') {
    return null;
  }

  const devTypesDir = path.resolve(projectRoot, distDir, 'dev', 'types');

  if (!fs.existsSync(devTypesDir)) {
    return null;
  }

  fs.rmSync(devTypesDir, { recursive: true, force: true });

  return devTypesDir;
}

/** Run `next build` in `projectRoot`, resolving the `next` binary from the app itself. */
export function runNextBuildProcess(projectRoot: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let nextBin: string;

    try {
      const require = createRequire(path.join(projectRoot, 'package.json'));
      const nextPkgPath = require.resolve('next/package.json');

      nextBin = path.resolve(path.dirname(nextPkgPath), 'dist/bin/next');
    } catch {
      reject(new Error(`Unable to resolve the "next" binary from ${projectRoot}. Is Next.js installed?`));

      return;
    }

    const proc = child_process.spawn(process.execPath, [nextBin, 'build'], {
      cwd: projectRoot,
      env: Object.assign({}, process.env, { NODE_ENV: 'production', [PP_DEV_NEXT_BUILD_ENV_VAR]: '1' }),
      stdio: 'inherit',
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`next build exited with code ${code}`));

        return;
      }

      resolve();
    });

    proc.on('error', reject);
  });
}
