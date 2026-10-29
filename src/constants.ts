import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const afterBundlePath = resolve(
  // After the build this module is a chunk in `dist/esm/` or `dist/cjs/`: the package is 3 levels up.
  (typeof __filename !== 'undefined' && __filename) || fileURLToPath(import.meta.url),
  '../../..',
);

const beforeBundlePath = resolve(
  // Run from source (`src/constants.ts`, e.g. in tests): the package is 2 levels up.
  (typeof __filename !== 'undefined' && __filename) || fileURLToPath(import.meta.url),
  '../..',
);

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
