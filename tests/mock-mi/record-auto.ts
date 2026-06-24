/**
 * Autonomous cassette recorder — no user interaction required.
 *
 * Usage (VPN must be enabled):
 *   REAL_MI_URL=https://stg7x.metricinsights.com npx tsx tests/mock-mi/record-auto.ts [cassette-name]
 *
 * What it does:
 *   1. Starts mock-MI server in record mode (proxies to real MI)
 *   2. Patches tests/test-nextjs/pp-dev.config.ts to point at mock server
 *   3. Starts pp-dev next, waits for it to be ready
 *   4. Makes a few HTTP requests to pp-dev to trigger MI API calls
 *   5. Saves cassette, restores config, exits
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { startMockMiServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_APP_DIR = path.resolve(__dirname, '../test-nextjs');
const CONFIG_PATH = path.join(TEST_APP_DIR, 'pp-dev.config.ts');
const CASSETTE_NAME = process.argv[2] ?? 'startup';
const REAL_MI_URL = process.env.REAL_MI_URL ?? 'https://stg7x.metricinsights.com';
const PP_DEV_JS = path.join(TEST_APP_DIR, 'node_modules/@metricinsights/pp-dev/bin/pp-dev.js');
const STARTUP_TIMEOUT = 90_000;
const REQUEST_TIMEOUT = 10_000;

function log(msg: string) {
  console.log(`[record-auto] ${msg}`);
}

log(`Recording cassette "${CASSETTE_NAME}" from ${REAL_MI_URL}`);

// 1. Start mock server in record mode
const mockMi = await startMockMiServer({
  mode: 'record',
  cassetteName: CASSETTE_NAME,
  realMiUrl: REAL_MI_URL,
});

const originalConfig = fs.readFileSync(CONFIG_PATH, 'utf-8');
let configPatched = false;

const cleanup = () => {
  if (configPatched) {
    fs.writeFileSync(CONFIG_PATH, originalConfig);
    log('Config restored.');
  }
};

process.once('uncaughtException', (err) => {
  console.error('[record-auto] Uncaught error:', err);
  cleanup();
  process.exit(1);
});

// 2. Patch config to point at mock server
const patched = originalConfig.replace(
  /url:\s*['"]https?:\/\/[^'"]+['"]/,
  `url: '${mockMi.url}'`,
);
if (patched === originalConfig) {
  console.error('[record-auto] Could not patch mi.url in pp-dev.config.ts — check the regex.');
  await mockMi.close();
  process.exit(1);
}
fs.writeFileSync(CONFIG_PATH, patched);
configPatched = true;
log(`Patched pp-dev.config.ts → mi.url = ${mockMi.url}`);

// 3. Start pp-dev next directly (no shell wrapper to avoid pipe latency on Windows)
log('Starting pp-dev next...');
const ppdev = spawn(process.execPath, [PP_DEV_JS, 'next'], {
  cwd: TEST_APP_DIR,
  env: { ...process.env, NO_COLOR: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

ppdev.stdout?.pipe(process.stdout);
ppdev.stderr?.pipe(process.stderr);

// 4. Wait for startup
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error(`pp-dev startup timed out after ${STARTUP_TIMEOUT}ms`)),
    STARTUP_TIMEOUT,
  );
  const onData = (data: Buffer) => {
    if (/pp-dev Next\.js server running/i.test(data.toString())) {
      clearTimeout(timer);
      resolve();
    }
  };
  ppdev.stdout?.on('data', onData);
  ppdev.stderr?.on('data', onData);
  ppdev.once('exit', (code) => {
    clearTimeout(timer);
    reject(new Error(`pp-dev exited early with code ${code}`));
  });
});

log('pp-dev is ready. Making requests to capture MI API calls...');

// 5. Make requests to trigger MI API calls (auth check, template vars, etc.)
const PP_BASE = 'http://localhost:3000';
const paths = ['/', '/pl/pp-dev-test-template/', '/data/page/index/auth/info'];

for (const p of paths) {
  try {
    const res = await fetch(`${PP_BASE}${p}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    log(`  ${p} → ${res.status}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`  ${p} → error: ${msg}`);
  }
}

// Give pending proxy responses time to be captured
await new Promise((r) => setTimeout(r, 2_000));

// 6. Save cassette explicitly before teardown
mockMi.save?.();

// 7. Teardown
ppdev.kill('SIGTERM');
await mockMi.close();
cleanup();

log('Done.');
process.exit(0);
