import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

export const PP_DEV_PACKAGE_DIR = resolve(
  // import.meta.url is `dist/node/constants.js` after bundle
  fileURLToPath(import.meta.url),
  '../..',
);

export const PP_DEV_CLIENT_ENTRY = resolve(PP_DEV_PACKAGE_DIR, 'dist/client/client.js');

const { version, name } = JSON.parse(readFileSync(resolve(PP_DEV_PACKAGE_DIR, 'package.json')).toString());

export const VERSION = version as string;
export const PACKAGE_NAME = name as string;

export const PP_WATCH_CONFIG_NAMES = ['.pp-watch.config.js', '.pp-watch.config.ts', '.pp-watch.config.json'] as const;

export const PP_DEV_CONFIG_NAMES = [
  '.pp-dev.config.js',
  '.pp-dev.config.ts',
  '.pp-dev.config.json',
  'pp-dev.config.js',
  'pp-dev.config.ts',
  'pp-dev.config.json',
] as const;
