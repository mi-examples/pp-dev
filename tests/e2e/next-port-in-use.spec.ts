/**
 * `pp-dev next` on a port something else listens on: the `error` event of `listen()` went unheard,
 * so the process ended with the stack dumps of uncaught exceptions and no word about the port.
 */
import { describe, it, afterAll, beforeAll, expect } from 'vitest';
import * as net from 'net';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { startDevServer, type DevServerProcess } from './helpers/pp-dev-process.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_APP_DIR = path.resolve(__dirname, '../test-nextjs');

describe('pp-dev next on a port in use', { timeout: 120_000 }, () => {
  let holder: net.Server;
  let port: number;
  let server: DevServerProcess | undefined;

  beforeAll(async () => {
    holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, 'localhost', resolve));
    port = (holder.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    server?.kill();
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  });

  it('says which port is in use and exits with 1, without an uncaught exception', async () => {
    server = startDevServer('npm', ['run', 'dev', '--', '--port', String(port)], {
      cwd: TEST_APP_DIR,
      shell: true,
      echo: true,
    });

    await server.waitForLine(new RegExp(`Port ${port} is already in use`), 90_000);

    expect(await server.closed).toBe(1);
    expect(server.lines.some((line) => /uncaughtException/i.test(line))).toBe(false);
  });
});
