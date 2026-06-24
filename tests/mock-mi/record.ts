#!/usr/bin/env node
/**
 * Record real MI API interactions for use in E2E tests.
 *
 * Usage (VPN must be enabled):
 *   npm run record:mi [cassette-name]
 *   npm run record:mi startup
 *
 * The script starts:
 *   1. mock-mi server in RECORD mode (proxies to real MI)
 *   2. pp-dev next in tests/test-nextjs with MI URL → mock server
 *
 * Interact with the dev server briefly, then press Ctrl+C.
 * Cassette is saved to tests/mock-mi/cassettes/<name>.json.
 *
 * IMPORTANT: review the cassette before committing — remove any tokens or
 * session cookies from response bodies / headers if sensitive.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { startMockMiServer, DEFAULT_PORT } from './server.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_APP_DIR = path.resolve(__dirname, '../test-nextjs');
const CONFIG_PATH = path.join(TEST_APP_DIR, 'pp-dev.config.ts');
const CASSETTE_NAME = process.argv[2] ?? 'startup';
const REAL_MI_URL = process.env.REAL_MI_URL;
const PP_DEV_JS = path.join(TEST_APP_DIR, 'node_modules/@metricinsights/pp-dev/bin/pp-dev.js');

if (!REAL_MI_URL) {
  console.error('Set REAL_MI_URL env var to the target MI instance, e.g.:');
  console.error('  REAL_MI_URL=https://stg7x.metricinsights.com npm run record:mi');
  process.exit(1);
}

console.log(`Recording cassette "${CASSETTE_NAME}" from ${REAL_MI_URL}`);

const mockMi = await startMockMiServer({
  mode: 'record',
  port: DEFAULT_PORT,
  cassetteName: CASSETTE_NAME,
  realMiUrl: REAL_MI_URL,
});

// Temporarily rewrite pp-dev.config.ts to point at the mock server
const originalConfig = fs.readFileSync(CONFIG_PATH, 'utf-8');
const patchedConfig = originalConfig.replace(
  /url:\s*['"]https?:\/\/[^'"]+['"]/,
  `url: '${mockMi.url}'`,
);
fs.writeFileSync(CONFIG_PATH, patchedConfig);

const ppdev = spawn(process.execPath, [PP_DEV_JS, 'next'], {
  cwd: TEST_APP_DIR,
  stdio: 'inherit',
  env: { ...process.env },
});

const cleanup = async (signal?: NodeJS.Signals) => {
  console.log(`\n[record] Stopping... (${signal ?? 'exit'})`);
  fs.writeFileSync(CONFIG_PATH, originalConfig);
  ppdev.kill();
  await mockMi.close();
};

process.once('SIGINT', () => cleanup('SIGINT').then(() => process.exit(0)));
process.once('SIGTERM', () => cleanup('SIGTERM').then(() => process.exit(0)));

ppdev.once('exit', () => {
  cleanup().then(() => process.exit(0));
});
