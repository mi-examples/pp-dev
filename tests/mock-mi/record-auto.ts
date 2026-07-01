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
 *   5. Directly fetches template metadata + ZIP download via mock-mi proxy
 *      (records the responses without needing a full next build / sync trigger)
 *   6. Saves cassette, restores config, exits
 */

import { spawn, type ChildProcess } from 'child_process';
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
const PP_PORT = Number(process.env.PP_DEV_RECORD_AUTO_PORT ?? 3000);
const PP_BASE = `http://localhost:${PP_PORT}`;
// Personal access token — if set, pp-dev adds it as Authorization: Bearer to all proxied
// requests, allowing authenticated MI endpoints to be recorded without a browser session.
const MI_ACCESS_TOKEN = process.env.MI_ACCESS_TOKEN ?? process.env.REAL_MI_TOKEN ?? '';

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

// Parse app ID from config before patching (used to discover template ID later)
const appIdMatch = originalConfig.match(/id:\s*(\d+)/);
const APP_ID = appIdMatch ? parseInt(appIdMatch[1], 10) : null;
if (APP_ID === null) {
  log('Warning: could not parse app.id from pp-dev.config.ts — template API calls will be skipped.');
}
let configPatched = false;
let ppdev: ChildProcess | undefined;
let mockClosed = false;

const cleanup = async () => {
  if (configPatched) {
    fs.writeFileSync(CONFIG_PATH, originalConfig);
    log('Config restored.');
  }

  if (ppdev && ppdev.exitCode === null && ppdev.signalCode === null) {
    ppdev.kill('SIGTERM');
  }

  if (!mockClosed) {
    await mockMi.close();
    mockClosed = true;
  }
};

try {
// 2. Patch config to point at mock server
const patched = originalConfig.replace(
  /url:\s*['"]https?:\/\/[^'"]+['"]/,
  `url: '${mockMi.url}'`,
);
if (patched === originalConfig) {
  throw new Error('Could not patch mi.url in pp-dev.config.ts — check the regex.');
}
fs.writeFileSync(CONFIG_PATH, patched);
configPatched = true;
log(`Patched pp-dev.config.ts → mi.url = ${mockMi.url}`);

if (!MI_ACCESS_TOKEN) {
  log(
    'Warning: MI_ACCESS_TOKEN / REAL_MI_TOKEN not set — authenticated MI endpoints will not be recorded.\n' +
      '         Set MI_ACCESS_TOKEN=<your-pat> to capture template API calls automatically.',
  );
}

// 3. Start pp-dev next directly (no shell wrapper to avoid pipe latency on Windows)
log('Starting pp-dev next...');
const child = spawn(process.execPath, [PP_DEV_JS, 'next', '--host', 'localhost', '--port', String(PP_PORT), '--strictPort'], {
  cwd: TEST_APP_DIR,
  env: { ...process.env, NO_COLOR: '1', MI_ACCESS_TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
});
ppdev = child;

child.stdout?.pipe(process.stdout);
child.stderr?.pipe(process.stderr);

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
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.once('exit', (code) => {
    clearTimeout(timer);
    reject(new Error(`pp-dev exited early with code ${code}`));
  });
});

log('pp-dev is ready. Making requests to capture MI API calls...');

// 5. Make requests to trigger MI API calls (auth check, template vars, etc.)
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

// 6. Fetch template API endpoints directly from mock-mi to record them.
//    These are used during template:sync (download + upload flow). We request
//    them through the mock-mi proxy so it records the real MI responses without
//    needing to trigger a full next build.
if (APP_ID !== null && MI_ACCESS_TOKEN) {
  const authHeaders: Record<string, string> = { Authorization: `Bearer ${MI_ACCESS_TOKEN}` };

  log(`Fetching page data to discover template ID (app ${APP_ID})...`);
  let templateId: number | null = null;
  try {
    const pageRes = await fetch(`${mockMi.url}/api/page/id/${APP_ID}`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (pageRes.ok) {
      const json = (await pageRes.json()) as { page?: { template_id?: number } };
      templateId = json?.page?.template_id ?? null;
      log(`  Discovered template_id: ${templateId}`);
    } else {
      log(`  /api/page/id/${APP_ID} → ${pageRes.status}`);
    }
  } catch (err) {
    log(`  /api/page/id/${APP_ID} → error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (templateId !== null) {
    // Template metadata
    try {
      const infoRes = await fetch(`${mockMi.url}/api/page_template/id/${templateId}`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
      log(`  /api/page_template/id/${templateId} → ${infoRes.status}`);
    } catch (err) {
      log(`  /api/page_template/id/${templateId} → error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Template ZIP download is skipped: server.ts rewrites its cassette entry to a synthetic
    // 404 during save, so fetching the (possibly large) archive here would only be discarded.
  }
} else if (APP_ID !== null) {
  log('Skipping template API fetch (no MI_ACCESS_TOKEN).');
}

// Give pending proxy responses time to be captured
await new Promise((r) => setTimeout(r, 2_000));

// 7. Save cassette explicitly before teardown
mockMi.save?.();

log('Done.');
} finally {
  await cleanup();
}
