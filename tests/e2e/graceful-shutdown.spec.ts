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
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { startMockMiServer, type MockMiServer } from '../mock-mi/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Fixture {
  name: string;
  dir: string;
  configFile: string;
  args: string[];
  port: number;
  ready: RegExp;
  signal: NodeJS.Signals;
}

const fixtures: Fixture[] = [
  {
    name: 'pp-dev (Vite)',
    dir: path.resolve(__dirname, '../test-commonjs'),
    configFile: 'pp-dev.config.ts',
    args: [],
    port: 3102,
    ready: /Config file watcher started/i,
    signal: 'SIGINT',
  },
  {
    name: 'pp-dev next',
    dir: path.resolve(__dirname, '../test-nextjs'),
    configFile: 'pp-dev.config.ts',
    args: ['next'],
    port: 3101,
    ready: /Config file watcher started/i,
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
      const configPath = path.join(fixture.dir, fixture.configFile);
      let originalConfig: string;
      let proc: ChildProcess | undefined;
      const lines: string[] = [];

      beforeAll(async () => {
        originalConfig = fs.readFileSync(configPath, 'utf-8');

        const patched = originalConfig.replace(/url:\s*['"]https?:\/\/[^'"]+['"]/, `url: '${mockMi.url}'`);

        if (patched === originalConfig) {
          throw new Error(`Could not point ${configPath} at mock-mi`);
        }

        fs.writeFileSync(configPath, patched);

        // The package's own bin, run by node directly: a signal sent to `npm run` reaches npm first.
        const bin = path.join(fixture.dir, 'node_modules', '@metricinsights', 'pp-dev', 'bin', 'pp-dev.js');

        proc = spawn(process.execPath, [bin, ...fixture.args, '--port', String(fixture.port)], {
          cwd: fixture.dir,
          env: { ...process.env, NO_COLOR: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`${fixture.name} did not start:\n${lines.join('\n')}`)),
            90_000,
          );
          let buffered = '';
          const onData = (data: Buffer) => {
            buffered += data.toString();

            const parts = buffered.split(/\r?\n/);

            buffered = parts.pop() ?? '';

            for (const line of parts.map((part) => part.trim()).filter(Boolean)) {
              lines.push(line);

              if (fixture.ready.test(line)) {
                clearTimeout(timer);
                resolve();
              }
            }
          };

          proc!.stdout!.on('data', onData);
          proc!.stderr!.on('data', onData);
          proc!.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`${fixture.name} exited with ${code} before it started:\n${lines.join('\n')}`));
          });
        });
      }, 120_000);

      afterAll(() => {
        if (proc && proc.exitCode === null && proc.signalCode === null) {
          proc.kill('SIGKILL');
        }

        if (originalConfig !== undefined) {
          fs.writeFileSync(configPath, originalConfig);
        }
      });

      it(`closes everything and exits with 0 on ${fixture.signal}`, async () => {
        expect(await isListening(fixture.port)).toBe(true);

        // Drops the "exited before it started" listener first.
        proc!.removeAllListeners('exit');

        // `close`, not `exit`: it comes once stdout and stderr have ended too, so the last log lines are in.
        const exited = new Promise<number | null>((resolve) => proc!.once('close', (code) => resolve(code)));

        proc!.kill(fixture.signal);

        const code = await Promise.race([
          exited,
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
        ]);
        const output = lines.join('\n');

        expect(code, output).toBe(0);
        expect(output).toContain(`Received ${fixture.signal}, shutting down gracefully`);
        expect(output).toContain('Graceful shutdown completed');
        expect(output).not.toMatch(/Shutdown did not finish|Error during graceful shutdown|Uncaught exception/);
        expect(await isListening(fixture.port)).toBe(false);
      });
    });
  }
});
