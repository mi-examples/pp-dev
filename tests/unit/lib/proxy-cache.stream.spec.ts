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

/** Wraps `res.write`/`res.end` the way a compression middleware does, upper-casing instead of zipping. */
function upperCaseWrites(res: http.ServerResponse) {
  const write = res.write;
  const end = res.end;
  const transform = (chunk: unknown) =>
    chunk === undefined || chunk === null || typeof chunk === 'function'
      ? chunk
      : Buffer.from(String(chunk).toUpperCase());

  res.write = function (this: http.ServerResponse, chunk: unknown, ...args: unknown[]) {
    return (write as (...a: unknown[]) => boolean).call(this, transform(chunk), ...args);
  } as http.ServerResponse['write'];

  res.end = function (this: http.ServerResponse, chunk?: unknown, ...args: unknown[]) {
    return (end as (...a: unknown[]) => http.ServerResponse).call(this, transform(chunk), ...args);
  } as http.ServerResponse['end'];
}

describe('proxy cache — responses it does not keep', () => {
  let upstream: http.Server;
  let proxy: http.Server;
  let port: number;
  let handler: Handler;
  let upstreamHits = 0;
  // A later middleware that wraps `res.write`/`res.end`, as Next.js's compression does.
  let wrapDownstream = false;
  // Answers instead of the proxy: a response the dev server makes itself (Next.js chunks, say).
  let localHandler: Handler | undefined;

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
      cacheMiddleware(req as never, res, () => {
        if (wrapDownstream) {
          upperCaseWrites(res);
        }

        if (localHandler) {
          localHandler(req, res);

          return;
        }

        proxyMiddleware(req as never, res, () => {
          res.statusCode = 404;
          res.end();
        });
      });
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
    wrapDownstream = false;
    localHandler = undefined;
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

  // The proxy rewrites a large text body as it arrives, which drops its Content-Length: the cache
  // then saw no size and held the first 10 MB before sending anything on.
  it('sends a large rewritten text body on as it arrives', async () => {
    const total = 10 * 1024 * 1024 + 1;
    const firstLine = '{"page":1}\n';
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));

    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': total });
      res.write(firstLine);
      void finished.then(() => res.end('a'.repeat(total - firstLine.length)));
    };

    const res = await get('/data/page/pp/assets/big.json');
    const first = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no data before the upstream ended')), 2000);

      res.once('data', (chunk: Buffer) => {
        clearTimeout(timer);
        resolve(chunk.toString());
      });
    });

    expect(first).toBe(firstLine);

    const rest = readAll(res);

    finish();
    expect((await rest).length + first.length).toBe(total);
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

  // Next.js compresses its chunks by wrapping `res.write`/`res.end` after the cache. The cache gave the
  // response its original methods back on the first write, dropping that wrapper: the rest of the
  // chunk went out uncompressed after a gzip start, and the browser failed it (ERR_CONTENT_DECODING_FAILED).
  it('keeps a wrapper set after it on a response the dev server makes itself', async () => {
    wrapDownstream = true;
    localHandler = (_req, res) => {
      res.setHeader('content-type', 'application/javascript');
      res.write('one ');
      res.write('two ');
      res.end('three');
    };

    expect((await readAll(await get('/pl/page/_next/static/chunks/a.js'))).toString()).toBe('ONE TWO THREE');
  });

  it('keeps a wrapper set after it on an event stream it passes through', async () => {
    wrapDownstream = true;
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => {
        res.write('data: two\n\n');
        res.end('data: three\n\n');
      }, 50);
    };

    expect((await readAll(await get('/data/page/pp/assets/events.txt'))).toString()).toBe(
      'DATA: ONE\n\nDATA: TWO\n\nDATA: THREE\n\n',
    );
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
