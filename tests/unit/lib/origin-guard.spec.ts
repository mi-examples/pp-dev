import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { crossOriginReason } from '../../../src/lib/helpers/origin-guard.js';
import { createInternalServer } from '../../../src/lib/internal.middleware.js';
import { PPDevHotServer } from '../../../src/lib/pp-ws-server.js';
import { PP_DEV_HMR_WS_PATH } from '../../../src/constants.js';

/**
 * Regression tests for cross-site requests to the dev server's own API and WebSocket.
 *
 * The internal API (users, login, variables, request inspector) and the `pp-dev next` dev-panel
 * WebSocket act with the developer's MI token, and checked neither `Origin` nor `Sec-Fetch-Site`.
 * Any page open in the browser could add a user or replace the token with a plain form POST to
 * `localhost:<port>` (no CORS preflight), or open the WebSocket and start a template sync to MI.
 */

const req = (headers: Record<string, string>, method = 'POST') =>
  ({ method, headers: { host: 'localhost:3000', ...headers } }) as unknown as http.IncomingMessage;

describe('crossOriginReason', () => {
  it.each([
    ['the same origin', { origin: 'http://localhost:3000' }],
    [
      'a saved user host calling its own API',
      { host: 'viewer.localhost:3000', origin: 'http://viewer.localhost:3000' },
    ],
    ['a LAN address, same origin', { host: '192.168.1.5:3000', origin: 'http://192.168.1.5:3000' }],
    ['a default port written out in Host', { host: 'localhost:80', origin: 'http://localhost' }],
    ['no browser headers (curl, a script)', {}],
    ['same-origin fetch metadata without Origin', { 'sec-fetch-site': 'same-origin' }],
    ['a typed URL', { 'sec-fetch-site': 'none' }],
  ])('lets %s through', (_name, headers) => {
    expect(crossOriginReason(req(headers))).toBeNull();
  });

  it.each([
    ['another site', { origin: 'https://evil.example' }],
    ['another dev server on localhost', { origin: 'http://localhost:5173' }],
    ['another saved user host', { host: 'localhost:3000', origin: 'http://viewer.localhost:3000' }],
    ['a sandboxed or file:// page', { origin: 'null' }],
    ['an unreadable Origin', { origin: '::not a url::' }],
    ['a cross-site form POST without Origin', { 'sec-fetch-site': 'cross-site' }],
    ['a same-site POST without Origin', { 'sec-fetch-site': 'same-site' }],
  ])('refuses %s', (_name, headers) => {
    expect(crossOriginReason(req(headers))).toEqual(expect.any(String));
  });

  it('lets a top-level navigation from another site open a page (no Origin on GET)', () => {
    expect(crossOriginReason(req({ 'sec-fetch-site': 'cross-site' }, 'GET'))).toBeNull();
  });

  it('refuses a cross-origin read (fetch sends Origin on GET too)', () => {
    expect(crossOriginReason(req({ origin: 'http://localhost:5173' }, 'GET'))).toEqual(expect.any(String));
  });
});

describe('internal API behind the origin guard', () => {
  let server: http.Server;
  let port: number;
  let calls = 0;

  beforeAll(async () => {
    const app = createInternalServer();

    app.all('/@api/users', (_req, res) => {
      calls += 1;
      res.json({ ok: true });
    });

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function send(method: string, headers: Record<string, string>, body = '') {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/@api/users',
          method,
          agent: false,
          headers: { host: `localhost:${port}`, ...headers },
        },
        (res) => {
          const chunks: Buffer[] = [];

          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );

      request.on('error', reject);
      request.end(body);
    });
  }

  it('refuses a hidden form POST from another site before the route runs', async () => {
    const before = calls;
    const res = await send(
      'POST',
      { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
      'name=attacker&token=stolen',
    );

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/^Blocked by pp-dev: Origin https:\/\/evil\.example/);
    expect(calls).toBe(before);
  });

  it('refuses a cross-site POST that carries no Origin', async () => {
    const res = await send('POST', { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, '{}');

    expect(res.status).toBe(403);
  });

  it("serves the dev server's own pages", async () => {
    const res = await send(
      'POST',
      { origin: `http://localhost:${port}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      '{"name":"qa"}',
    );

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('serves non-browser clients', async () => {
    expect((await send('GET', {})).status).toBe(200);
  });
});

describe('pp-dev next dev-panel WebSocket behind the origin guard', () => {
  let server: http.Server;
  let hot: PPDevHotServer;
  let port: number;

  beforeAll(async () => {
    hot = new PPDevHotServer();
    server = http.createServer();
    server.on('upgrade', (request, socket, head) => {
      if (!hot.handleUpgrade(request, socket, head)) {
        socket.destroy();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await hot.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function connect(origin?: string) {
    return new Promise<{ opened: boolean; status?: number }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${PP_DEV_HMR_WS_PATH}`, {
        headers: { host: `localhost:${port}` },
        ...(origin ? { origin } : {}),
      });

      ws.on('open', () => {
        ws.close();
        resolve({ opened: true });
      });
      ws.on('unexpected-response', (_request, response) => resolve({ opened: false, status: response.statusCode }));
      ws.on('error', () => resolve({ opened: false }));
    });
  }

  it('refuses a WebSocket opened by another site', async () => {
    expect(await connect('https://evil.example')).toEqual({ opened: false, status: 403 });
  });

  it('refuses a WebSocket opened by another dev server on localhost', async () => {
    expect(await connect('http://localhost:5173')).toEqual({ opened: false, status: 403 });
  });

  it("accepts the dev server's own page", async () => {
    expect(await connect(`http://localhost:${port}`)).toEqual({ opened: true });
  });
});
