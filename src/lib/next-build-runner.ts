import * as path from 'path';
import * as child_process from 'child_process';
import * as process from 'process';
import { createRequire } from 'module';
import { PP_DEV_NEXT_BUILD_ENV_VAR } from '../constants.js';

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
