/**
 * E2E tests for the config file watcher's restart, with the real commands of the test fixtures
 * against mock-mi.
 *
 * - `pp-dev next` with a `withPPDev()` layout: a restart in one process never applied a changed
 *   `pp-dev.config.*` (Next.js caches `loadConfig()` for the life of the process), so the restarted
 *   server kept the first backend URL. The server runs in a process of its own now.
 * - A save during a restart was lost (`isRestarting` returned early): the first save's config stayed.
 * - A `pp-dev.config.*` that can't be loaded ended the running server with `process.exit(1)`, with
 *   its session; it is kept now, under both commands.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { startMockMiServer, type MockMiServer } from '../mock-mi/server.js';
import { startDevServer, type DevServerProcess } from './helpers/pp-dev-process.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const URL_IN_CONFIG = /url:\s*['"]https?:\/\/[^'"]+['"]/;
const RUNNING = /pp-dev Next\.js server running|PP-DEV v\d/;
const BACKEND_URL = /Backend URL: (\S+)/;

/** Whether something accepts connections on `port`. */
function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: 'localhost' });

    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Resolves once `count` lines match `pattern`; rejects after `timeoutMs` with the output so far. */
function waitForLines(server: DevServerProcess, pattern: RegExp, count: number, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      if (server.lines.filter((line) => pattern.test(line)).length >= count) {
        resolve();
      } else if (server.proc.exitCode !== null) {
        reject(
          new Error(`Exited with ${server.proc.exitCode} before ${count} × ${pattern}:\n${server.lines.join('\n')}`),
        );
      } else if (Date.now() - started > timeoutMs) {
        reject(new Error(`Timeout waiting for ${count} × ${pattern}:\n${server.lines.join('\n')}`));
      } else {
        setTimeout(check, 100);
      }
    };

    check();
  });
}

const countLines = (server: DevServerProcess, pattern: RegExp) =>
  server.lines.filter((line) => pattern.test(line)).length;

/** The last backend URL the dev server reported. */
const lastBackendUrl = (server: DevServerProcess) =>
  server.lines
    .map((line) => BACKEND_URL.exec(line)?.[1])
    .filter(Boolean)
    .at(-1);

/** Edits the fixture's `pp-dev.config.ts` from its original content, and restores it after the suite. */
function configEditor(configPath: string) {
  const original = fs.readFileSync(configPath, 'utf-8');

  return {
    pointAt(url: string) {
      const patched = original.replace(URL_IN_CONFIG, `url: '${url}'`);

      if (patched === original) {
        throw new Error(`Could not point ${configPath} at ${url}`);
      }

      fs.writeFileSync(configPath, patched);
    },
    /** A half-written config: a save with the closing braces not typed yet. */
    breakIt() {
      fs.writeFileSync(configPath, original.slice(0, original.indexOf('app:')));
    },
    restore() {
      fs.writeFileSync(configPath, original);
    },
  };
}

interface Fixture {
  name: string;
  dir: string;
  args: string[];
  port: number;
}

// Ports of their own: 3105 and 3106 were the Playwright runner's defaults, and the two suites
// collided when run at the same time locally.
const fixtures: Fixture[] = [
  {
    name: 'pp-dev next (withPPDev layout)',
    dir: path.resolve(__dirname, '../test-nextjs'),
    args: ['--port', '3115'],
    port: 3115,
  },
  {
    name: 'pp-dev (Vite)',
    dir: path.resolve(__dirname, '../test-commonjs'),
    args: ['--port', '3116', '--strictPort'],
    port: 3116,
  },
];

describe('restart on a config change', { timeout: 120_000 }, () => {
  let mockMi: MockMiServer;
  /** The same mock-mi under another name: a changed `mi.url` the server can still reach. */
  let otherMiUrl: string;

  beforeAll(async () => {
    mockMi = await startMockMiServer({ mode: 'replay', cassetteName: 'startup' });
    otherMiUrl = mockMi.url.replace('localhost', '127.0.0.1');
  });

  afterAll(async () => {
    await mockMi?.close();
  });

  for (const fixture of fixtures) {
    describe(fixture.name, () => {
      let config: ReturnType<typeof configEditor>;
      let server: DevServerProcess;

      beforeAll(async () => {
        config = configEditor(path.join(fixture.dir, 'pp-dev.config.ts'));
        config.pointAt(mockMi.url);
        // `npm run dev`, so npm resolves the node binary (process.execPath may be an nvm4w shim that
        // breaks chokidar's native watcher).
        server = startDevServer('npm', ['run', 'dev', '--', ...fixture.args], {
          cwd: fixture.dir,
          shell: true,
          echo: true,
        });
        await server.waitForLine(/Config file watcher started/i, 90_000);
        await waitForLines(server, BACKEND_URL, 1, 10_000);
      }, 120_000);

      afterAll(() => {
        server?.kill();
        config?.restore();
      });

      it('applies the changed config after the restart', async () => {
        expect(lastBackendUrl(server)).toBe(mockMi.url);

        const startsBefore = countLines(server, RUNNING);

        config.pointAt(otherMiUrl);

        await waitForLines(server, RUNNING, startsBefore + 1);
        await waitForLines(server, BACKEND_URL, startsBefore + 1, 10_000);

        expect(lastBackendUrl(server)).toBe(otherMiUrl);
        expect(await isListening(fixture.port)).toBe(true);
      });

      it('runs one more restart for a save that came during the restart', async () => {
        const restartsBefore = countLines(server, /Restarting dev server/);
        const startsBefore = countLines(server, RUNNING);

        config.pointAt(mockMi.url);
        await waitForLines(server, /Restarting dev server/, restartsBefore + 1);
        // The restart is under way (a server takes seconds to stop and start): the second save must
        // not be lost with it.
        config.pointAt(otherMiUrl);

        await waitForLines(server, RUNNING, startsBefore + 2, 90_000);
        await waitForLines(server, BACKEND_URL, startsBefore + 2, 10_000);

        expect(lastBackendUrl(server)).toBe(otherMiUrl);
        expect(await isListening(fixture.port)).toBe(true);
      });

      // Under `pp-dev`, Vite restarted on its own when a `.env` file changed, with the plugin
      // instance (and the pp-dev config) of the first start, 500 ms before pp-dev's own restart.
      it('restarts once for a .env file', async () => {
        const envFile = path.join(fixture.dir, '.env');
        const startsBefore = countLines(server, RUNNING);

        try {
          fs.writeFileSync(envFile, 'MI_PP_DEV_E2E_ENV=1\n');

          await waitForLines(server, RUNNING, startsBefore + 1);
          await new Promise((resolve) => setTimeout(resolve, 5_000));

          expect(countLines(server, RUNNING)).toBe(startsBefore + 1);
          expect(server.lines.some((line) => /changed, restarting server/.test(line))).toBe(false);
          expect(await isListening(fixture.port)).toBe(true);
        } finally {
          fs.rmSync(envFile, { force: true });
        }

        // Removing it is a change too.
        await waitForLines(server, RUNNING, startsBefore + 2);
      });

      it('keeps the running server when the config cannot be loaded', async () => {
        const startsBefore = countLines(server, RUNNING);

        config.breakIt();

        await server.waitForLine(
          /could not be loaded, the dev server keeps running|The running dev server is kept/,
          60_000,
        );

        expect(countLines(server, RUNNING)).toBe(startsBefore);
        expect(await isListening(fixture.port)).toBe(true);
        expect(server.proc.exitCode).toBeNull();

        // The next save, a valid one, restarts as usual.
        config.pointAt(mockMi.url);

        await waitForLines(server, RUNNING, startsBefore + 1);
        await waitForLines(server, BACKEND_URL, startsBefore + 1, 10_000);

        expect(lastBackendUrl(server)).toBe(mockMi.url);
      });
    });
  }
});
