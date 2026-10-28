import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { initProxy } from '../../../src/lib/proxy-pass.middleware.js';
import type { MiAPI } from '../../../src/lib/pp.middleware.js';

/**
 * Regression tests for redirects and keep-alive connections through the proxy.
 *
 * `autoRewrite` never ran (`selfHandleResponse` skips http-proxy's response passes), so a redirect
 * MI made to itself sent the browser from the dev server to MI. And each proxied request added a
 * `close` listener to the keep-alive socket, holding its upstream request until the socket closed.
 */

function listen(server: http.Server) {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('proxy-pass middleware — redirects and keep-alive', () => {
  let upstream: http.Server;
  let proxy: http.Server;
  let port: number;
  let upstreamOrigin: string;
  let location = '';
  let lastSocket: Socket | undefined;
  let lastReferer: string | undefined;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      lastReferer = req.headers.referer;

      if (req.url?.startsWith('/redirect')) {
        res.writeHead(302, { location });
        res.end();

        return;
      }

      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });

    const upstreamPort = await listen(upstream);

    upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;

    const middleware = initProxy({
      baseURL: upstreamOrigin,
      devServer: {} as never,
      miAPI: { v7Features: false } as unknown as MiAPI,
    });

    proxy = http.createServer((req, res) => {
      lastSocket = req.socket;
      middleware(req as never, res, () => {
        res.statusCode = 404;
        res.end();
      });
    });
    port = await listen(proxy);
  });

  afterAll(async () => {
    proxy.closeAllConnections();
    await close(proxy);
    await close(upstream);
  });

  function get(path: string, headers: http.OutgoingHttpHeaders = {}, agent: http.Agent | false = false) {
    return new Promise<http.IncomingMessage>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path, headers, agent }, (res) => {
          res.resume();
          res.on('end', () => resolve(res));
        })
        .on('error', reject);
    });
  }

  it("points a redirect to MI's own host at the dev server", async () => {
    location = `${upstreamOrigin}/home?x=1#top`;

    const res = await get('/redirect', { host: 'localhost:3000' });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://localhost:3000/home?x=1#top');
  });

  it('keeps the scheme the dev server was reached with', async () => {
    location = `${upstreamOrigin}/home`;

    const res = await get('/redirect', { host: 'localhost:3000', 'x-forwarded-proto': 'https' });

    expect(res.headers.location).toBe('https://localhost:3000/home');
  });

  it('leaves relative redirects and redirects elsewhere as they are', async () => {
    location = '/home';
    expect((await get('/redirect', { host: 'localhost:3000' })).headers.location).toBe('/home');

    location = 'https://idp.example.com/sso';
    expect((await get('/redirect', { host: 'localhost:3000' })).headers.location).toBe('https://idp.example.com/sso');

    // Another port on the same address is another host.
    location = `${upstreamOrigin}1/home`;
    expect((await get('/redirect', { host: 'localhost:3000' })).headers.location).toBe(`${upstreamOrigin}1/home`);
  });

  it('sends the Referer as from MI', async () => {
    await get('/api/x', { host: 'localhost:3000', referer: 'http://localhost:3000/p/page?y=2' });

    expect(lastReferer).toBe(`${upstreamOrigin}/p/page?y=2`);
  });

  it('does not add a socket listener per request on a keep-alive connection', async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

    try {
      await get('/api/x', {}, agent);

      const socket = lastSocket!;
      const listeners = socket.listenerCount('close');

      for (let i = 0; i < 5; i += 1) {
        await get('/api/x', {}, agent);
      }

      expect(lastSocket).toBe(socket);
      expect(socket.listenerCount('close')).toBe(listeners);
    } finally {
      agent.destroy();
    }
  });
});
