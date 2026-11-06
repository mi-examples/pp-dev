import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * This module's own path. From `import.meta.url` in both builds: rollup gives the CJS one a
 * polyfill made of that module's `__filename`. A `__filename` found in scope was taken first, as
 * the CJS build's, but `node -e` and the REPL define a global one (`[eval]`), from which the ESM
 * build resolved the package directory and failed on its package.json.
 */
const modulePath = fileURLToPath(import.meta.url);

// After the build this module is a chunk in `dist/esm/` or `dist/cjs/`: the package is 3 levels up.
const afterBundlePath = resolve(modulePath, '../../..');

// Run from source (`src/constants.ts`, e.g. in tests): the package is 2 levels up.
const beforeBundlePath = resolve(modulePath, '../..');

export const PP_DEV_PACKAGE_DIR = existsSync(resolve(afterBundlePath, 'package.json'))
  ? afterBundlePath
  : beforeBundlePath;

export const PP_DEV_CLIENT_ENTRY = resolve(PP_DEV_PACKAGE_DIR, 'dist/client/client.js');

const { version, name } = JSON.parse(readFileSync(resolve(PP_DEV_PACKAGE_DIR, 'package.json')).toString());

export const VERSION = version as string;
export const PACKAGE_NAME = name as string;

// The WebSocket path the dev panel talks to the `pp-dev next` server on, shared with the panel.
export { PP_DEV_HMR_WS_PATH } from './shared/ws-messages.js';

export const PATH_PAGE_PREFIX = '/p';
export const PATH_TEMPLATE_PREFIX = '/pt';
export const PATH_TEMPLATE_LOCAL_PREFIX = '/pl';

/**
 * Set (to '1') in the child `next build` process spawned by `pp-dev next-build` (and the
 * WS-triggered sync build in DistService). `withPPDev()` checks this during the production
 * build phase to tell a wrapped `next build` apart from a bare one, so it can nudge users
 * running `next build` directly toward `pp-dev next-build` (VERSION/BUILD-MANIFEST/zip parity).
 */
export const PP_DEV_NEXT_BUILD_ENV_VAR = 'PP_DEV_NEXT_BUILD';

/**
 * The `distDir` a `next build` started by pp-dev is to use, applied by `withPPDev()` during the
 * production build phase. A template sync sets it so that its build, exported apart, leaves the
 * running dev server's `<distDir>/dev` alone (see `DistService.buildNextAssets`).
 */
export const PP_DEV_NEXT_BUILD_DIST_DIR_ENV_VAR = 'PP_DEV_NEXT_BUILD_DIST_DIR';

/**
 * The project root `pp-dev next` and `pp-dev next-build` were given, for `withPPDev()`: Next
 * evaluates `next.config` with no root to pass on, so run from a parent directory it read that
 * directory's package.json and pp-dev config ("app.name is required").
 */
export const PP_DEV_PROJECT_ROOT_ENV_VAR = 'PP_DEV_PROJECT_ROOT';

export const PP_DEV_CONFIG_NAMES = [
  '.pp-dev.config.js',
  '.pp-dev.config.cjs',
  '.pp-dev.config.mjs',
  '.pp-dev.config.ts',
  '.pp-dev.config.cts',
  '.pp-dev.config.mts',
  '.pp-dev.config.json',
  'pp-dev.config.js',
  'pp-dev.config.cjs',
  'pp-dev.config.mjs',
  'pp-dev.config.ts',
  'pp-dev.config.cts',
  'pp-dev.config.mts',
  'pp-dev.config.json',
] as const;
