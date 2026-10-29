/**
 * E2E tests for how `pp-dev` and `pp-dev next` stop on a signal: the process handlers close the
 * config watcher, the WebSocket and the HTTP server, then exit with 0 (see
 * `src/lib/process-handlers.ts`). Unit tests cover the handlers against a fake process; these run
 * the real commands of the test fixtures, against mock-mi.
 *
 * POSIX only: on Windows a signal can't be sent to another process (`process.kill(pid, 'SIGINT')`
 * is TerminateProcess), so no handler would run.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import * as net from 'net';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { startMockMiServer, type MockMiServer } from '../mock-mi/server.js';
import { pointConfigAt, startDevServer, type DevServerProcess } from './helpers/pp-dev-process.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Fixture {
  name: string;
  dir: string;
  configFile: string;
  args: string[];
  port: number;
  signal: NodeJS.Signals;
}

const fixtures: Fixture[] = [
  {
    name: 'pp-dev (Vite)',
    dir: path.resolve(__dirname, '../test-commonjs'),
    configFile: 'pp-dev.config.ts',
    // Vite would move to the next free port; the test must fail on a taken one instead, saying why.
    args: ['--strictPort'],
    port: 3102,
    signal: 'SIGINT',
  },
  {
    name: 'pp-dev next',
    dir: path.resolve(__dirname, '../test-nextjs'),
    configFile: 'pp-dev.config.ts',
    args: ['next'],
    port: 3101,
    signal: 'SIGTERM',
  },
];

/** Whether something still accepts connections on `port`. */
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

describe.skipIf(process.platform === 'win32')('graceful shutdown on a signal', { timeout: 120_000 }, () => {
  let mockMi: MockMiServer;

  beforeAll(async () => {
    mockMi = await startMockMiServer({ mode: 'replay', cassetteName: 'startup' });
  });

  afterAll(async () => {
    await mockMi?.close();
  });

  for (const fixture of fixtures) {
    describe(fixture.name, () => {
      let config: { restore(): void } | undefined;
      let server: DevServerProcess | undefined;

      beforeAll(async () => {
        config = pointConfigAt(path.join(fixture.dir, fixture.configFile), mockMi.url);

        // The package's own bin, run by node directly: a signal sent to `npm run` reaches npm first.
        const bin = path.join(fixture.dir, 'node_modules', '@metricinsights', 'pp-dev', 'bin', 'pp-dev.js');

        server = startDevServer(process.execPath, [bin, ...fixture.args, '--port', String(fixture.port)], {
          cwd: fixture.dir,
        });
        await server.waitForLine(/Config file watcher started/i, 90_000);
      }, 120_000);

      afterAll(() => {
        // The whole process group: a server that didn't stop may have left Next.js workers running,
        // holding the port for the next E2E file.
        server?.kill('SIGKILL');
        config?.restore();
      });

      it(`closes everything and exits with 0 on ${fixture.signal}`, async () => {
        expect(await isListening(fixture.port)).toBe(true);

        // To the server process alone, as a terminal's Ctrl+C or a process manager would send it.
        server!.proc.kill(fixture.signal);

        // `closed` settles once stdout and stderr have ended too, so the last log lines are in.
        const code = await Promise.race([
          server!.closed,
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
        ]);
        const output = server!.lines.join('\n');

        expect(code, output).toBe(0);
        expect(output).toContain(`Received ${fixture.signal}, shutting down gracefully`);
        expect(output).toContain('Graceful shutdown completed');
        expect(output).not.toMatch(/Shutdown did not finish|Error during graceful shutdown|Uncaught exception/);
        expect(await isListening(fixture.port)).toBe(false);
      });
    });
  }
});
