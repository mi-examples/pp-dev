/**
 * E2E tests for pp-dev server lifecycle.
 *
 * These tests run pp-dev against mock-mi replay so CI never depends on the
 * VPN-only MI instance during startup.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { startMockMiServer, type MockMiServer } from '../mock-mi/server.js';

// On Windows, proc.kill('SIGTERM') only kills the shell (npm.cmd), not the
// node/next child processes. POSIX uses a detached process group for the same reason.
function killTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  if (process.platform === 'win32') {
    try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
  } else {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_APP_DIR = path.resolve(__dirname, '../test-nextjs');
const CONFIG_PATH = path.join(TEST_APP_DIR, 'pp-dev.config.ts');

// ── ProcOutput — persistent line accumulator so no data event is missed ──

interface ProcOutput {
  lines: string[];
  waitForLine(pattern: RegExp, timeoutMs?: number): Promise<string>;
  kill(): void;
}

function startPPDev(extraEnv?: Record<string, string>): ProcOutput {
  // Use npm run dev so npm resolves the node binary via nvm4w correctly.
  // process.execPath on nvm4w points to a shim that breaks chokidar's native watcher.
  const proc: ChildProcess = spawn('npm', ['run', 'dev'], {
    cwd: TEST_APP_DIR,
    env: { ...process.env, NO_COLOR: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    detached: process.platform !== 'win32',
  });

  const lines: string[] = [];
  const listeners: Array<(line: string) => void> = [];
  let lineBuffer = '';

  const onData = (data: Buffer) => {
    const text = data.toString();
    process.stdout.write(text);
    lineBuffer += text;
    const parts = lineBuffer.split(/\r?\n/);
    lineBuffer = parts.pop() ?? '';
    for (const raw of parts) {
      const line = raw.trim();
      if (!line) continue;
      lines.push(line);
      for (const fn of [...listeners]) fn(line);
    }
  };

  proc.stdout?.on('data', onData);
  proc.stderr?.on('data', onData);

  return {
    lines,

    waitForLine(pattern: RegExp, timeoutMs = 30_000): Promise<string> {
      // Check already-buffered lines first
      const buffered = lines.find((l) => pattern.test(l));
      if (buffered) return Promise.resolve(buffered);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = listeners.indexOf(onLine);
          if (idx !== -1) listeners.splice(idx, 1);
          reject(new Error(`Timeout (${timeoutMs}ms) waiting for: ${pattern}`));
        }, timeoutMs);

        const onLine = (line: string) => {
          if (pattern.test(line)) {
            clearTimeout(timer);
            const idx = listeners.indexOf(onLine);
            if (idx !== -1) listeners.splice(idx, 1);
            resolve(line);
          }
        };
        listeners.push(onLine);

        // Re-check in case lines arrived between the buffered check and listener registration
        const recheck = lines.find((l) => pattern.test(l));
        if (recheck) {
          clearTimeout(timer);
          const idx = listeners.indexOf(onLine);
          if (idx !== -1) listeners.splice(idx, 1);
          resolve(recheck);
        }
      });
    },

    kill: () => killTree(proc),
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────

describe('pp-dev server lifecycle', { timeout: 60_000 }, () => {
  let ppdev: ProcOutput;
  let mockMi: MockMiServer;
  let originalConfig: string;

  beforeAll(async () => {
    mockMi = await startMockMiServer({ mode: 'replay', cassetteName: 'startup' });
    originalConfig = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const patchedConfig = originalConfig.replace(
      /url:\s*['"]https?:\/\/[^'"]+['"]/,
      `url: '${mockMi.url}'`,
    );

    if (patchedConfig === originalConfig) {
      throw new Error('Could not patch test pp-dev config to use mock-mi');
    }

    fs.writeFileSync(CONFIG_PATH, patchedConfig);

    // Start pp-dev against mock-mi so CI never depends on the VPN-only MI instance.
    ppdev = startPPDev();
    // Wait for the very last startup log so all startup lines are in ppdev.lines
    await ppdev.waitForLine(/Process event handlers registered/i, 60_000);
  }, 90_000);

  afterAll(async () => {
    ppdev?.kill();
    // Ensure config was not left modified by any test
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const restored = (originalConfig ?? content).replace(/\n\/\/ restart-trigger\n/g, '');
    if (restored !== content) fs.writeFileSync(CONFIG_PATH, restored);
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
    expect(await res.json()).toMatchObject({ authenticated: true });
  });
});
