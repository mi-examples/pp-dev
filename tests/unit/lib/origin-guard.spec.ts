import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { crossOriginReason, hostNotAllowedMessage, isHostAllowed } from '../../../src/lib/helpers/origin-guard.js';
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
    // Separate local dev servers whose pages work together.
    ['another dev server on localhost', { origin: 'http://localhost:5173' }],
    ['another dev server on 127.0.0.1', { origin: 'http://127.0.0.1:8080' }],
    ['another dev server on [::1]', { origin: 'http://[::1]:4200' }],
    ['an https dev server on localhost', { origin: 'https://localhost:5174' }],
    ['another saved user host', { host: 'localhost:3000', origin: 'http://viewer.localhost:3000' }],
    [
      'a page on localhost calling the dev server on a LAN address',
      { host: '192.168.1.5:3000', origin: 'http://localhost:5173' },
    ],
    ['a same-site POST without Origin (another localhost port)', { 'sec-fetch-site': 'same-site' }],
  ])('lets %s through', (_name, headers) => {
    expect(crossOriginReason(req(headers))).toBeNull();
  });

  it.each([
    ['another site', { origin: 'https://evil.example' }],
    ['a name that only starts with localhost', { origin: 'http://localhost.evil.example' }],
    ['a name that only ends like localhost', { origin: 'http://evil-localhost' }],
    ['another machine on the LAN', { origin: 'http://192.168.1.9:3000' }],
    ['an address that only starts with 127', { origin: 'http://127.0.0.1.evil.example' }],
    ['a sandboxed or file:// page', { origin: 'null' }],
    ['an unreadable Origin', { origin: '::not a url::' }],
    ['a cross-site form POST without Origin', { 'sec-fetch-site': 'cross-site' }],
  ])('refuses %s', (_name, headers) => {
    expect(crossOriginReason(req(headers))).toEqual(expect.any(String));
  });

  it('lets a top-level navigation from another site open a page (no Origin on GET)', () => {
    expect(crossOriginReason(req({ 'sec-fetch-site': 'cross-site' }, 'GET'))).toBeNull();
  });

  it("refuses another site's cross-origin read (fetch sends Origin on GET too)", () => {
    expect(crossOriginReason(req({ origin: 'https://evil.example' }, 'GET'))).toEqual(expect.any(String));
  });

  // A tunnel that rewrites Host to localhost (ngrok --host-header=rewrite, cloudflared, nginx)
  // leaves its own name in Origin: refused before allowedHosts, whatever the method.
  it('lets a page on a host named in allowedHosts call through a tunnel that rewrites Host', () => {
    const tunnel = req({ host: 'localhost:3000', origin: 'https://my-app.ngrok.app' });

    expect(crossOriginReason(tunnel)).toEqual(expect.any(String));
    expect(crossOriginReason(tunnel, ['my-app.ngrok.app'])).toBeNull();
  });

  it.each([
    ['a .domain entry (any tunnel on it, also someone else’s)', ['.ngrok.app']],
    ['another name', ['other.ngrok.app']],
    ['true, which only answers any Host', true as const],
  ])('refuses that page with %s', (_name, allowedHosts) => {
    expect(
      crossOriginReason(req({ host: 'localhost:3000', origin: 'https://my-app.ngrok.app' }), allowedHosts),
    ).toEqual(expect.any(String));
  });
});

/**
 * DNS rebinding under `pp-dev next`, whose server is pp-dev's own (Vite checks Host itself under
 * `pp-dev`): a page on `evil.example:3000` whose name the attacker then points at 127.0.0.1 is
 * same-origin with the dev server, so the Origin check above lets it reach the API and the
 * WebSocket. The Host it sends is still `evil.example:3000`.
 */
describe('isHostAllowed', () => {
  it.each([
    ['localhost', 'localhost:3000'],
    ['localhost without a port', 'localhost'],
    ['a saved user host', 'viewer.localhost:3000'],
    ['uppercase', 'LOCALHOST:3000'],
    ['IPv4 loopback', '127.0.0.1:3000'],
    ['a LAN address', '192.168.1.5:3000'],
    ['IPv6 loopback', '[::1]:3000'],
    ['no Host (HTTP/1.0, a script)', undefined],
  ])('answers %s', (_name, host) => {
    expect(isHostAllowed(host, [])).toBe(true);
  });

  it.each([
    ['another name', 'evil.example:3000'],
    ['a name that only starts with localhost', 'localhost.evil.example:3000'],
    ['a name that only ends like localhost', 'evil-localhost:3000'],
    ['an IPv4 address with a name after it', '127.0.0.1.evil.example'],
    ['an unreadable IPv6 address', '[::1'],
    ['an empty Host', ''],
  ])('refuses %s', (_name, host) => {
    expect(isHostAllowed(host, [])).toBe(false);
  });

  it('answers the names in allowedHosts, a leading dot for the domain and its subdomains', () => {
    const allowed = ['my-app.ngrok.app', '.trycloudflare.com'];

    expect(isHostAllowed('my-app.ngrok.app', allowed)).toBe(true);
    expect(isHostAllowed('My-App.Ngrok.App:443', allowed)).toBe(true);
    expect(isHostAllowed('trycloudflare.com', allowed)).toBe(true);
    expect(isHostAllowed('a.b.trycloudflare.com', allowed)).toBe(true);
    expect(isHostAllowed('other.ngrok.app', allowed)).toBe(false);
    expect(isHostAllowed('eviltrycloudflare.com', allowed)).toBe(false);
  });

  it('answers any host with true', () => {
    expect(isHostAllowed('evil.example:3000', true)).toBe(true);
  });

  it('says which name to add to server.allowedHosts', () => {
    expect(hostNotAllowedMessage('evil.example:3000')).toBe(
      'Blocked by pp-dev: this host ("evil.example") is not allowed. To allow it, add "evil.example" to server.allowedHosts in the pp-dev config.',
    );
  });
});

describe('internal API behind the origin guard', () => {
  let server: http.Server;
  let port: number;
  let calls = 0;

  beforeAll(async () => {
    const app = createInternalServer({ allowedHosts: ['my-app.ngrok.app', '.trycloudflare.com'] });

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

  it('serves a page of another dev server on this machine', async () => {
    const res = await send(
      'POST',
      { origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site', 'content-type': 'application/json' },
      '{"name":"qa"}',
    );

    expect(res.status).toBe(200);
  });

  it('serves non-browser clients', async () => {
    expect((await send('GET', {})).status).toBe(200);
  });

  it('serves a page on a host named in allowedHosts, through a tunnel that rewrites Host', async () => {
    const post = (origin: string) =>
      send('POST', { origin, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, '{}');

    expect((await post('https://my-app.ngrok.app')).status).toBe(200);
    expect((await post('https://someone.trycloudflare.com')).status).toBe(403);
  });
});

describe('pp-dev next dev-panel WebSocket behind the origin guard', () => {
  let server: http.Server;
  let hot: PPDevHotServer;
  let port: number;

  beforeAll(async () => {
    hot = new PPDevHotServer({ allowedHosts: ['my-app.ngrok.app'] });
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

  it('refuses a WebSocket opened by another machine on the LAN', async () => {
    expect(await connect('http://192.168.1.9:3000')).toEqual({ opened: false, status: 403 });
  });

  it('accepts a WebSocket opened by another dev server on this machine', async () => {
    expect(await connect('http://localhost:5173')).toEqual({ opened: true });
  });

  it("accepts the dev server's own page", async () => {
    expect(await connect(`http://localhost:${port}`)).toEqual({ opened: true });
  });

  it('accepts a page on a host named in allowedHosts, through a tunnel that rewrites Host', async () => {
    expect(await connect('https://my-app.ngrok.app')).toEqual({ opened: true });
    expect(await connect('https://other.ngrok.app')).toEqual({ opened: false, status: 403 });
  });

  it("frees the server's socket for a refused upgrade, even when the peer keeps its side open", async () => {
    const connections = () =>
      new Promise<number>((resolve, reject) =>
        server.getConnections((error, count) => (error ? reject(error) : resolve(count))),
      );
    // allowHalfOpen: this peer never ends its own side, so only the server can free the socket.
    const peer = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });

    const response = await new Promise<string>((resolve) => {
      let received = '';

      peer.on('data', (chunk: Buffer) => {
        received += chunk.toString('latin1');
      });
      // The server has sent its 403 and ended its side.
      peer.on('end', () => resolve(received));
      peer.write(
        [
          `GET ${PP_DEV_HMR_WS_PATH} HTTP/1.1`,
          `Host: localhost:${port}`,
          'Origin: https://evil.example',
          'Upgrade: websocket',
          'Connection: Upgrade',
          // Generated: a literal key reads like a credential to secret scanners.
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join(String.fromCharCode(13, 10)),
      );
    });

    expect(response.startsWith('HTTP/1.1 403 Forbidden')).toBe(true);

    try {
      await expect.poll(connections, { timeout: 1000 }).toBe(0);
    } finally {
      peer.destroy();
    }
  });
});
