import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { initRewriteResponse } from '../../../src/lib/rewrite-response.middleware.js';

/**
 * Vite serves index.html through its send(): an ETag of the transformed file, and a 304 with no
 * body to a matching If-None-Match. The page the browser got was rewritten after that (the
 * variable values, the dev panel), so a reload after "Reload variables" was answered 304 and kept
 * the old values. Through the real Vite server, as `curl` sees it.
 */
describe('rewrite response under Vite', () => {
  let root: string;
  let vite: ViteDevServer;
  let server: http.Server;
  let port: number;
  let value = 'one';

  /** As a browser navigation asks: it accepts HTML. */
  function get(path: string, headers: http.OutgoingHttpHeaders = {}) {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      http
        .request(
          { host: '127.0.0.1', port, path, headers: { accept: 'text/html', ...headers }, agent: false },
          (res) => {
            const chunks: Buffer[] = [];

            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
            );
          },
        )
        .on('error', reject)
        .end();
    });
  }

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'pp-dev-vite-etag-'));
    writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><body><p>[Name]</p></body></html>\n');

    vite = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      server: { middlewareMode: true, hmr: false, watch: null },
      plugins: [
        {
          name: 'pp-dev-test-rewrite',
          configureServer(server) {
            // After Vite's own middlewares, as pp-dev's plugin mounts it.
            return () => {
              server.middlewares.use(
                initRewriteResponse(
                  (url) => url.split('?')[0].endsWith('index.html'),
                  (body) => Buffer.from(body.toString('utf8').replace('[Name]', value)),
                ),
              );
            };
          },
        },
      ],
    });

    server = http.createServer(vite.middlewares);
    port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await vite.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('answers a reload with the page rewritten with the current values, not a 304 by the old ETag', async () => {
    const first = await get('/index.html');

    expect(first.status).toBe(200);
    expect(first.body).toContain('<p>one</p>');
    // The ETag was of the page before the rewrite, which no browser gets.
    expect(first.headers.etag).toBeUndefined();

    value = 'two';

    const reload = await get('/index.html', { 'if-none-match': first.headers.etag ?? 'W/"stale"' });

    expect(reload.status).toBe(200);
    expect(reload.body).toContain('<p>two</p>');
  });
});
