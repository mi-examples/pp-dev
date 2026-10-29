/**
 * E2E tests for pp-dev server lifecycle.
 *
 * These tests run pp-dev against mock-mi replay so CI never depends on the
 * VPN-only MI instance during startup.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { startMockMiServer, type MockMiServer } from '../mock-mi/server.js';
import { pointConfigAt, startDevServer, type DevServerProcess } from './helpers/pp-dev-process.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_APP_DIR = path.resolve(__dirname, '../test-nextjs');
const CONFIG_PATH = path.join(TEST_APP_DIR, 'pp-dev.config.ts');

function startPPDev(extraEnv?: Record<string, string>, args: string[] = []): DevServerProcess {
  // Use npm run dev so npm resolves the node binary via nvm4w correctly.
  // process.execPath on nvm4w points to a shim that breaks chokidar's native watcher.
  return startDevServer('npm', ['run', 'dev', ...(args.length ? ['--', ...args] : [])], {
    cwd: TEST_APP_DIR,
    env: extraEnv,
    shell: true,
    echo: true,
  });
}

// ── Suite ─────────────────────────────────────────────────────────────────

describe('pp-dev server lifecycle', { timeout: 60_000 }, () => {
  let ppdev: DevServerProcess;
  let mockMi: MockMiServer;
  let config: { restore(): void } | undefined;

  beforeAll(async () => {
    mockMi = await startMockMiServer({ mode: 'replay', cassetteName: 'startup' });
    // Start pp-dev against mock-mi so CI never depends on the VPN-only MI instance.
    config = pointConfigAt(CONFIG_PATH, mockMi.url);
    ppdev = startPPDev();
    // Wait for the very last startup log so all startup lines are in ppdev.lines
    await ppdev.waitForLine(/Config file watcher started/i, 60_000);
  }, 90_000);

  afterAll(async () => {
    ppdev?.kill();
    config?.restore();
    await mockMi?.close();
  });

  // ── 1: Clean startup ──────────────────────────────────────────────────

  it('starts cleanly without errors', () => {
    const errors = ppdev.lines.filter((l) =>
      /\[ERROR\]|esbuild error|unhandled exception/i.test(l),
    );
    expect(errors, `Unexpected errors:\n${errors.join('\n')}`).toHaveLength(0);
    // Verify server reached the ready state
    expect(ppdev.lines.some((l) => /pp-dev Next\.js server running/i.test(l))).toBe(true);
  });

  // ── 2: Config watcher is active ───────────────────────────────────────

  it('sets up config file watcher', () => {
    const watcherLine = ppdev.lines.find((l) => /Config file watcher started/i.test(l));
    expect(watcherLine, 'Config file watcher started message not found').toBeTruthy();
  });

  // ── 3: HTTP sanity-check ──────────────────────────────────────────────

  it('serves HTTP responses', async () => {
    const res = await fetch('http://localhost:3000/', {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    // Expects a redirect (302) or page response — anything below 500
    expect(res.status).toBeLessThan(500);
  });

  it('loads page data from mock-mi cassette', async () => {
    const res = await fetch('http://localhost:3000/pl/pp-dev-test-template/', {
      signal: AbortSignal.timeout(10_000),
    });

    expect(res.status).toBeLessThan(500);
    await ppdev.waitForLine(/Page fetched/i, 10_000);
    await ppdev.waitForLine(/Local page template fetched/i, 10_000);
  });

  it('proxies MI data requests through mock-mi cassette', async () => {
    const res = await fetch('http://localhost:3000/data/page/index/auth/info', {
      signal: AbortSignal.timeout(10_000),
    });

    expect(res.status).toBe(200);
    // Asserts shape, not MI's exact auth-info schema (which has changed under us before) — this
    // is only here to prove the proxy round-trips a real cassette response for this path.
    expect(await res.json()).toMatchObject({ user: expect.any(Object) });
  });
});

// A standalone page with no backend: no `mi.url`, no `app.id`. `pp-dev next` used to make up a
// backend (`http://localhost:8080`) for it; without one, it first failed to start ("Custom App ID is
// required…"), then started without serving the Request Inspector it prints, whose routes were only
// mounted along with the MI middleware.
describe('pp-dev next without a backend', { timeout: 60_000 }, () => {
  const PORT = 3100;
  let ppdev: DevServerProcess;
  let originalConfig: string;

  beforeAll(async () => {
    originalConfig = fs.readFileSync(CONFIG_PATH, 'utf-8');
    fs.writeFileSync(
      CONFIG_PATH,
      [
        "import { defineConfig } from '@metricinsights/pp-dev';",
        '',
        "export default defineConfig({ mi: { mode: 'standalone', apiVersion: 7 }, app: { type: 'page' } });",
        '',
      ].join('\n'),
    );

    ppdev = startPPDev({ MI_BACKEND_URL: '' }, ['--port', String(PORT)]);
    await ppdev.waitForLine(/Config file watcher started|Custom App ID is required/i, 60_000);
  }, 90_000);

  afterAll(() => {
    ppdev?.kill();

    if (originalConfig !== undefined) {
      fs.writeFileSync(CONFIG_PATH, originalConfig);
    }
  });

  it('starts', () => {
    const errors = ppdev.lines.filter((l) => /\[ERROR\]|Custom App ID is required|unhandled exception/i.test(l));

    expect(errors, `Unexpected errors:\n${errors.join('\n')}`).toHaveLength(0);
    expect(ppdev.lines.some((l) => /pp-dev Next\.js server running/i.test(l))).toBe(true);
    expect(ppdev.lines.some((l) => /Backend URL/i.test(l))).toBe(false);
  });

  it('serves the Request Inspector it advertises', async () => {
    expect(ppdev.lines.some((l) => /Request Inspector/i.test(l))).toBe(true);

    const page = await fetch(`http://localhost:${PORT}/@pp-dev/inspector`, { signal: AbortSignal.timeout(10_000) });

    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);

    const list = await fetch(`http://localhost:${PORT}/@api/requests`, { signal: AbortSignal.timeout(10_000) });

    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ requests: expect.any(Array) });
  });
});
