import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const afterBundlePath = resolve(
  // import.meta.url is `dist/node/constants.js` after bundle
  (typeof __filename !== 'undefined' && __filename) || fileURLToPath(import.meta.url),
  '../../..',
);

const beforeBundlePath = resolve(
  // import.meta.url is `dist/node/constants.js` after bundle
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

/**
 * WebSocket path used by the dev-panel client to talk to the `pp-dev next` server
 * (the non-Vite fallback transport). Kept in sync with the client-side copy in
 * `src/client/hot-context.ts`.
 */
export const PP_DEV_HMR_WS_PATH = '/@pp-dev-hmr';

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
