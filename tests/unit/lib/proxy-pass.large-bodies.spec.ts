import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getResponseHandling, initProxy } from '../../../src/lib/proxy-pass.middleware.js';
import type { MiAPI } from '../../../src/lib/pp.middleware.js';

/**
 * Regression tests for how big and binary MI responses go through the proxy.
 *
 * Everything that wasn't an event stream went through `responseInterceptor`, which holds the whole
 * body before the first byte goes out: a large file from MI reached the browser only once MI had sent
 * all of it, and a binary one `file-type` didn't recognise was decoded as UTF-8 and rewritten,
 * corrupting it.
 */

function listen(server: http.Server) {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

const MB = 1024 * 1024;

describe('getResponseHandling', () => {
  it.each([
    [{ 'content-type': 'application/octet-stream' }, 'pipe'],
    [{ 'content-type': 'image/png', 'content-length': '10' }, 'pipe'],
    [{ 'content-type': 'font/woff2' }, 'pipe'],
    [{ 'content-type': 'text/html; charset=utf-8' }, 'buffer'],
    [{ 'content-type': 'image/svg+xml' }, 'buffer'],
    [{ 'content-type': 'application/json', 'content-length': String(MB) }, 'buffer'],
    [{ 'content-type': 'application/json', 'content-length': String(10 * MB) }, 'stream'],
    // A page may get the return-from-login script or the token login form: rewritten as a whole.
    [{ 'content-type': 'text/html; charset=utf-8', 'content-length': String(10 * MB) }, 'buffer'],
    [{ 'content-type': 'application/xhtml+xml', 'content-length': String(10 * MB) }, 'buffer'],
    // Compressed text has to be decoded to be rewritten, which the stream doesn't do.
    [{ 'content-type': 'application/json', 'content-length': String(10 * MB), 'content-encoding': 'gzip' }, 'buffer'],
    [{ 'content-length': String(10 * MB) }, 'buffer'],
    [{}, 'buffer'],
  ] as const)('%o → %s', (headers, handling) => {
    expect(getResponseHandling(headers)).toBe(handling);
  });
});

describe('proxy-pass middleware — big and binary MI responses', () => {
  let upstream: http.Server;
  let proxy: http.Server;
  let port: number;
  let upstreamOrigin: string;
  let handle: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => res.end();

  beforeAll(async () => {
    upstream = http.createServer((req, res) => handle(req, res));

    upstreamOrigin = `http://127.0.0.1:${await listen(upstream)}`;

    const middleware = initProxy({
      baseURL: upstreamOrigin,
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
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    await close(proxy);
    await close(upstream);
  });

  /** GETs `path` through the proxy; `onFirstChunk` runs once, with the first bytes received. */
  function get(path: string, onFirstChunk?: (chunk: Buffer) => void) {
    return new Promise<{ res: http.IncomingMessage; body: Buffer }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path, headers: { host: 'localhost:3000' }, agent: false }, (res) => {
          const chunks: Buffer[] = [];

          res.on('data', (chunk: Buffer) => {
            if (chunks.length === 0) {
              onFirstChunk?.(chunk);
            }

            chunks.push(chunk);
          });
          res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
        })
        .on('error', reject);
    });
  }

  /** Settles once `promise` does, or fails after `ms`: data held back until the end never comes. */
  function within<T>(promise: Promise<T>, ms: number, what: string) {
    return Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`${what} within ${ms} ms`)), ms)),
    ]);
  }

  it('passes a binary file through byte for byte, even one with the MI address in it', async () => {
    // Not valid UTF-8, and not a format file-type knows.
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x00, 0xc3]),
      Buffer.from(`${upstreamOrigin}/x`),
      Buffer.from([0x80, 0x81]),
    ]);

    handle = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
      res.end(bytes);
    };

    const { res, body } = await get('/file.bin');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe(String(bytes.length));
    expect(body.equals(bytes)).toBe(true);
  });

  it('sends a binary file on as it arrives, before MI has sent all of it', async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));

    handle = (_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': 8 });
      res.write(Buffer.from('1234'));
      // The rest only once the client has the first half.
      void finished.then(() => res.end(Buffer.from('5678')));
    };

    let firstChunk!: (chunk: Buffer) => void;
    const first = new Promise<Buffer>((resolve) => (firstChunk = resolve));
    const response = get('/video.mp4', firstChunk);

    expect((await within(first, 3000, 'no data before the upstream ended')).toString()).toBe('1234');
    finish();
    expect((await response).body.toString()).toBe('12345678');
  });

  it('rewrites a large text response as it arrives, before MI has sent all of it', async () => {
    // With the SAML login pointed at /login, as the buffered rewrite does.
    const firstLine = `{"url":"${upstreamOrigin}/home","login":"/auth/saml/login"}\n`;
    const total = 10 * MB + 1;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));

    handle = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': total });
      res.write(firstLine);
      void finished.then(() => res.end('a'.repeat(total - Buffer.byteLength(firstLine))));
    };

    let firstChunk!: (chunk: Buffer) => void;
    const first = new Promise<Buffer>((resolve) => (firstChunk = resolve));
    const response = get('/big.json', firstChunk);

    expect((await within(first, 3000, 'no data before the upstream ended')).toString()).toBe(
      '{"url":"http://localhost:3000/home","login":"/login"}\n',
    );
    finish();

    const { res, body } = await response;

    // Rewritten, so no longer the length MI announced.
    expect(res.headers['content-length']).toBeUndefined();
    expect(body.length).toBe(
      total - upstreamOrigin.length + 'http://localhost:3000'.length - '/auth/saml/login'.length + '/login'.length,
    );
  });

  it('still adds the return-from-login script to a large page', async () => {
    const page = `<html><body>${'x'.repeat(10 * MB)}</body></html>`;

    handle = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(page) });
      res.end(page);
    };

    const { body } = await get('/home?proxyRedirect=%2Fp%2Fpage');

    expect(body.toString()).toContain('pp-dev::redirectCount');
  });

  it('still rewrites the MI address in SVG and other text', async () => {
    handle = (req, res) => {
      const svg = req.url?.endsWith('.svg');

      res.writeHead(200, { 'content-type': svg ? 'image/svg+xml' : 'application/json' });
      res.end(svg ? `<svg><image href="${upstreamOrigin}/a.png"/></svg>` : `{"u":"${upstreamOrigin}/b"}`);
    };

    expect((await get('/icon.svg')).body.toString()).toBe('<svg><image href="http://localhost:3000/a.png"/></svg>');
    expect((await get('/data.json')).body.toString()).toBe('{"u":"http://localhost:3000/b"}');
  });
});
