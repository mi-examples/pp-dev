import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { initProxyCache, cache } from '../../../src/lib/proxy-cache.middleware.js';
import { initProxy } from '../../../src/lib/proxy-pass.middleware.js';
import type { MiAPI } from '../../../src/lib/pp.middleware.js';

/**
 * Regression tests for the proxy cache holding responses it would never keep.
 *
 * For every proxied GET of a path with a file extension, the cache captured the whole body before
 * sending anything: a Server-Sent Events stream reached the browser only once it ended, a redirect
 * or error was held for nothing, and the 10 MB limit applied only to storing, not to holding.
 */

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const listen = (server: http.Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );

const close = (server: http.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe('proxy cache — responses it does not keep', () => {
  let upstream: http.Server;
  let proxy: http.Server;
  let port: number;
  let handler: Handler;
  let upstreamHits = 0;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      upstreamHits += 1;
      handler(req, res);
    });

    const upstreamPort = await listen(upstream);
    const cacheMiddleware = initProxyCache({ devServer: {} as never });
    const proxyMiddleware = initProxy({
      baseURL: `http://127.0.0.1:${upstreamPort}`,
      devServer: {} as never,
      miAPI: { v7Features: false } as unknown as MiAPI,
    });

    proxy = http.createServer((req, res) => {
      cacheMiddleware(req as never, res, () =>
        proxyMiddleware(req as never, res, () => {
          res.statusCode = 404;
          res.end();
        }),
      );
    });
    port = await listen(proxy);
  });

  afterAll(async () => {
    await close(proxy);
    await close(upstream);
  });

  beforeEach(() => {
    cache.clear();
    upstreamHits = 0;
  });

  function get(path: string) {
    return new Promise<http.IncomingMessage>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path, agent: false }, resolve).on('error', reject);
    });
  }

  function readAll(res: http.IncomingMessage) {
    return new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];

      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  it('sends an event stream as it arrives, not once it ends', async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));

    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: first\n\n');
      void finished.then(() => res.end('data: last\n\n'));
    };

    const res = await get('/data/page/pp/assets/events.txt');
    const first = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no event before the stream ended')), 2000);

      res.once('data', (chunk: Buffer) => {
        clearTimeout(timer);
        resolve(chunk.toString());
      });
    });

    expect(first).toContain('data: first');

    const rest = readAll(res);

    finish();
    expect((await rest).toString()).toContain('data: last');
    expect(cache.getItemCount()).toBe(0);
  });

  it('streams a body over the cache limit through, whole, without keeping it', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 'x');
    const chunks = 11;

    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });

      for (let i = 0; i < chunks; i += 1) {
        res.write(chunk);
      }

      res.end('end');
    };

    const body = await readAll(await get('/data/page/pp/assets/big.bin'));

    expect(body.length).toBe(chunk.length * chunks + 3);
    expect(body.subarray(-3).toString()).toBe('end');
    expect(cache.getItemCount()).toBe(0);
  });

  it('still caches a complete 200', async () => {
    handler = (_req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.end('cached');
    };

    expect((await readAll(await get('/data/page/pp/assets/a.txt'))).toString()).toBe('cached');
    expect((await readAll(await get('/data/page/pp/assets/a.txt'))).toString()).toBe('cached');
    expect(upstreamHits).toBe(1);
  });
});
