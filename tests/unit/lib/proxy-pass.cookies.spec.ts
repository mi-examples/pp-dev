import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { initProxy } from '../../../src/lib/proxy-pass.middleware.js';
import type { MiAPI } from '../../../src/lib/pp.middleware.js';

/**
 * Regression test for PP-4238: the MI session cookie must reach the browser without `Secure` when
 * the dev server runs over plain HTTP, otherwise Safari drops it and the login form loops.
 */

const SESSION_COOKIE = 'metric_insights_session=abc123; Max-Age=31536000; path=/; secure; httponly; samesite=lax';

function listen(server: http.Server) {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function get(port: number, path: string, headers: http.OutgoingHttpHeaders = {}) {
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res));
      })
      .on('error', reject);
  });
}

describe('proxy-pass middleware — Set-Cookie', () => {
  let upstream: http.Server;
  let proxy: http.Server;
  let proxyPort: number;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      res.setHeader('set-cookie', [SESSION_COOKIE, 'other=1; Domain=127.0.0.1; Secure; SameSite=None']);

      if (req.url === '/stream') {
        res.setHeader('content-type', 'text/event-stream');
        res.end('data: ok\n\n');

        return;
      }

      res.setHeader('content-type', 'text/html');
      res.end('<html><body>home</body></html>');
    });

    const upstreamPort = await listen(upstream);

    const middleware = initProxy({
      baseURL: `http://127.0.0.1:${upstreamPort}`,
      devServer: {} as never,
      miAPI: { v7Features: false } as unknown as MiAPI,
    });

    proxy = http.createServer((req, res) => {
      middleware(req as never, res, () => {
        res.statusCode = 404;
        res.end();
      });
    });

    proxyPort = await listen(proxy);
  });

  afterAll(async () => {
    await close(proxy);
    await close(upstream);
  });

  it.each(['/home', '/stream'])('strips Secure and Domain on a plain-HTTP dev server (%s)', async (path) => {
    const res = await get(proxyPort, path);

    expect(res.headers['set-cookie']).toEqual([
      'metric_insights_session=abc123; Max-Age=31536000; path=/; httponly; samesite=lax',
      'other=1; SameSite=Lax',
    ]);
  });

  it('keeps Secure behind a TLS-terminating proxy', async () => {
    const res = await get(proxyPort, '/home', { 'x-forwarded-proto': 'https' });

    expect(res.headers['set-cookie']).toEqual([SESSION_COOKIE, 'other=1; Secure; SameSite=None']);
  });
});
