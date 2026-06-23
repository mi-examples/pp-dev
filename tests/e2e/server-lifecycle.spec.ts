/**
 * E2E tests for pp-dev server lifecycle.
 *
 * These tests do NOT use the mock MI server — pp-dev initializes lazily and
 * never calls MI during startup, so the tests pass without VPN or mock.
 * The mock server and cassettes are reserved for request-path tests.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

// On Windows, proc.kill('SIGTERM') only kills the shell (npm.cmd), not the
// node/next child processes. Use taskkill /T to kill the entire process tree.
function killTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  if (process.platform === 'win32') {
    try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
  } else {
    proc.kill('SIGTERM');
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
  });

  const lines: string[] = [];
  const listeners: Array<(line: string) => void> = [];

  const onData = (data: Buffer) => {
    const text = data.toString();
    process.stdout.write(text);
    for (const raw of text.split('\n')) {
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

  beforeAll(async () => {
    // Start pp-dev with the unmodified config (original MI URL).
    // pp-dev is lazy about MI connections — startup succeeds without VPN.
    ppdev = startPPDev();
    // Wait for the very last startup log so all startup lines are in ppdev.lines
    await ppdev.waitForLine(/Process event handlers registered/i, 60_000);
  }, 90_000);

  afterAll(() => {
    ppdev?.kill();
    // Ensure config was not left modified by any test
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const restored = content.replace(/\n\/\/ restart-trigger\n/g, '');
    if (restored !== content) fs.writeFileSync(CONFIG_PATH, restored);
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
});
