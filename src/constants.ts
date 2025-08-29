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

export const PP_DEV_PACKAGE_DIR = existsSync(resolve(afterBundlePath, 'package.json')) ? afterBundlePath : beforeBundlePath;

console.log('PP_DEV_PACKAGE_DIR', PP_DEV_PACKAGE_DIR);
console.log('afterBundlePath', afterBundlePath);
console.log('beforeBundlePath', beforeBundlePath);

export const PP_DEV_CLIENT_ENTRY = resolve(PP_DEV_PACKAGE_DIR, 'dist/client/client.js');

const { version, name } = JSON.parse(readFileSync(resolve(PP_DEV_PACKAGE_DIR, 'package.json')).toString());

export const VERSION = version as string;
export const PACKAGE_NAME = name as string;

export const PP_WATCH_CONFIG_NAMES = ['.pp-watch.config.js', '.pp-watch.config.ts', '.pp-watch.config.json'] as const;

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
