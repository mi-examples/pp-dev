import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { initProxy } from '../../../src/lib/proxy-pass.middleware.js';
import type { MiAPI } from '../../../src/lib/pp.middleware.js';

/**
 * Regression test for PP-4238 follow-up: after logging in again, Safari served portal page images
 * from its own HTTP cache and drew them as black boxes, although the Network preview showed the
 * right image. MI responses depend on the session, so the browser must never reuse one.
 */

function listen(server: http.Server) {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function get(port: number, path: string, headers: http.OutgoingHttpHeaders = {}, method = 'GET') {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    http
      .request({ host: '127.0.0.1', port, path, headers, method }, (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      })
      .on('error', reject)
      .end();
  });
}

// 1x1 PNG, so the proxy treats the body as binary.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

describe('proxy-pass middleware — browser cache', () => {
  let upstream: http.Server;
  let proxy: http.Server;
  let port: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders = {};

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      lastUpstreamHeaders = req.headers;

      res.setHeader('etag', '"v1"');
      res.setHeader('last-modified', 'Tue, 29 Sep 2026 00:00:00 GMT');
      res.setHeader('cache-control', 'public, max-age=86400');
      res.setHeader('expires', 'Wed, 30 Sep 2026 00:00:00 GMT');
      res.setHeader('pragma', 'cache');

      if (req.headers['if-none-match'] === '"v1"' || req.url?.endsWith('/unchanged')) {
        res.statusCode = 304;
        res.end();

        return;
      }

      if (req.url?.endsWith('/empty')) {
        res.statusCode = 204;
        res.end();

        return;
      }

      res.setHeader('content-type', 'image/png');
      res.end(PNG);
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

    port = await listen(proxy);
  });

  afterAll(async () => {
    await close(proxy);
    await close(upstream);
  });

  it('tells the browser not to store MI responses', async () => {
    const res = await get(port, '/data/page/pp/assets/logo.png');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['expires']).toBeUndefined();
    expect(res.headers['pragma']).toBeUndefined();
    expect(res.body.equals(PNG)).toBe(true);
  });

  it('answers a conditional request with the full image, not a 304 for an old browser copy', async () => {
    const res = await get(port, '/data/page/pp/assets/logo.png', {
      'if-none-match': '"v1"',
      'if-modified-since': 'Tue, 29 Sep 2026 00:00:00 GMT',
    });

    expect(lastUpstreamHeaders['if-none-match']).toBeUndefined();
    expect(lastUpstreamHeaders['if-modified-since']).toBeUndefined();
    expect(res.status).toBe(200);
    expect(res.body.equals(PNG)).toBe(true);
  });

  // The buffered path's interceptor ends a HEAD, 204 or 304 on its own, and `X-PP-Proxy` was never
  // set: the inspector filed them as local, and the proxy cache did not look at them for a session
  // change.
  it.each([
    ['a 304', '/data/page/pp/unchanged', 'GET', 304],
    ['a 204', '/data/page/pp/empty', 'GET', 204],
    ['a HEAD', '/data/page/pp/empty', 'HEAD', 204],
  ])('marks %s answered by MI as proxied', async (_name, path, method, status) => {
    const res = await get(port, path, {}, method);

    expect(res.status).toBe(status);
    expect(res.headers['x-pp-proxy']).toBe('1');
  });
});
