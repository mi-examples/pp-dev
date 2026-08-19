import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import initProxy from '../../../src/lib/proxy-pass.middleware.js';
import type { MiAPI } from '../../../src/lib/pp.middleware.js';

/**
 * End-to-end check that a proxied streaming response gets the same treatment as every other
 * proxied response: the upstream host is rewritten to the host the browser asked for, and the
 * upstream status code reaches the client. Both were lost for `text/event-stream` responses,
 * which were piped through untouched with a hard-coded 200.
 */
describe('proxy-pass streaming responses', () => {
  let upstream: Server;
  let local: Server;
  let upstreamHost: string;
  let localPort: number;

  const miAPI = {
    personalAccessToken: undefined,
    v7Features: false,
    internalPageName: undefined,
  } as unknown as MiAPI;

  const get = (path: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: localPort, path, method: 'GET' }, (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });

      req.on('error', reject);
      req.end();
    });

  beforeEach(async () => {
    upstream = createServer((req, res) => {
      if (req.url?.startsWith('/stream')) {
        res.writeHead(503, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`data: {"next":"http://${upstreamHost}/data/page/next"}\n\n`);
        res.end();

        return;
      }

      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><body><a href="http://${upstreamHost}/data/page/next">go</a></body></html>`);
    });

    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));

    const upstreamAddress = upstream.address();

    upstreamHost = `127.0.0.1:${typeof upstreamAddress === 'object' && upstreamAddress ? upstreamAddress.port : 0}`;

    const proxy = initProxy({ baseURL: `http://${upstreamHost}`, devServer: {} as never, miAPI });

    local = createServer((req, res) => {
      proxy(req as never, res as never, () => {
        res.statusCode = 404;
        res.end('not proxied');
      });
    });

    await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', () => resolve()));

    const localAddress = local.address();

    localPort = typeof localAddress === 'object' && localAddress ? localAddress.port : 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => local.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('rewrites the upstream host in a streamed body', async () => {
    const streamed = await get('/stream');

    expect(streamed.body).toContain(`http://127.0.0.1:${localPort}/data/page/next`);
    expect(streamed.body).not.toContain(upstreamHost);
  });

  it('forwards the upstream status code of a streamed response', async () => {
    const streamed = await get('/stream');

    expect(streamed.status).toBe(503);
  });

  it('still rewrites the upstream host in a non-streamed body', async () => {
    const html = await get('/page');

    expect(html.status).toBe(200);
    expect(html.body).toContain(`http://127.0.0.1:${localPort}/data/page/next`);
  });
});
