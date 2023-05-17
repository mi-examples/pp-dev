import { readFileSync } from 'fs';

const { version, name } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url)).toString(),
);

export const VERSION = version as string;
export const PACKAGE_NAME = name as string;

export const PP_WATCH_CONFIG_NAMES = [
  '.pp-watch.config.js',
  '.pp-watch.config.ts',
  '.pp-watch.config.json',
] as const;

export const PP_DEV_CONFIG_NAMES = [
  '.pp-dev.config.js',
  '.pp-dev.config.ts',
  '.pp-dev.config.json',
  'pp-dev.config.js',
  'pp-dev.config.ts',
  'pp-dev.config.json',
] as const;
