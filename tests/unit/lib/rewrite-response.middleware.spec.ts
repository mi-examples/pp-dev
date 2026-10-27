import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync, gzipSync } from 'node:zlib';
import { initRewriteResponse } from '../../../src/lib/rewrite-response.middleware.js';
import { createLogger } from '../../../src/lib/logger.js';

/**
 * Regression tests for "pages are cut short under `pp-dev next`".
 *
 * Next.js (`send-payload.js`) sets `Content-Length` for the HTML it rendered and then calls
 * `res.end(html)`. The rewrite middleware replaces that body with a longer one (page template,
 * dev panel, host rewriting) but left the header as it was, so browsers stopped reading at the
 * original length and Node clients failed with HPE_INVALID_CONSTANT. Vite never sets the header,
 * which is why only the Next.js path was affected.
 *
 * The tests go through a real HTTP server and client: a stale `Content-Length` is only visible
 * on the wire.
 */

const ORIGINAL = '<html><body><h1>Page</h1></body></html>';
const PANEL = `<div id="pp-dev-panel">${'x'.repeat(200)}</div>`;
const REWRITTEN = ORIGINAL.replace('</body>', `${PANEL}</body>`);

function injectPanel(body: Buffer) {
  return Buffer.from(body.toString('utf8').replace('</body>', `${PANEL}</body>`));
}

type Served = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

async function serve(respond: (res: http.ServerResponse) => void) {
  const middleware = initRewriteResponse(() => true, injectPanel);

  const server = http.createServer((req, res) => {
    void middleware(req as any, res, () => respond(res));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address() as AddressInfo;

  const get = () =>
    new Promise<Served>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
        res.on('error', reject);
      });

      req.on('error', reject);
    });

  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));

  try {
    return await get();
  } finally {
    await close();
  }
}

describe('initRewriteResponse', () => {
  it('updates a Content-Length preset by the renderer to the rewritten body (Next.js send-payload)', async () => {
    const served = await serve((res) => {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Length', Buffer.byteLength(ORIGINAL));
      res.end(ORIGINAL);
    });

    expect(served.status).toBe(200);
    expect(served.body.toString('utf8')).toBe(REWRITTEN);
    expect(served.headers['content-length']).toBe(String(Buffer.byteLength(REWRITTEN)));
  });

  it('sets the length of the re-encoded body when the response is compressed', async () => {
    const compressed = gzipSync(Buffer.from(ORIGINAL));

    const served = await serve((res) => {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', compressed.length);
      res.end(compressed);
    });

    expect(gunzipSync(served.body).toString('utf8')).toBe(REWRITTEN);
    expect(served.headers['content-length']).toBe(String(served.body.length));
  });

  it('serves the whole rewritten body when no Content-Length was preset (Vite)', async () => {
    const served = await serve((res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(ORIGINAL);
    });

    expect(served.body.toString('utf8')).toBe(REWRITTEN);
    expect(served.headers['content-length']).toBe(String(served.body.length));
  });

  it('keeps a Buffer passed to end()', async () => {
    const served = await serve((res) => {
      res.end(Buffer.from(ORIGINAL));
    });

    expect(served.body.toString('utf8')).toBe(REWRITTEN);
  });

  it('collects string chunks passed to write()', async () => {
    const served = await serve((res) => {
      res.write(ORIGINAL.slice(0, 12));
      res.write(ORIGINAL.slice(12));
      res.end();
    });

    expect(served.body.toString('utf8')).toBe(REWRITTEN);
  });

  it('keeps the bytes of a chunk whose producer reuses the buffer once the write is acknowledged', async () => {
    const served = await serve((res) => {
      const reused = Buffer.from(ORIGINAL);

      res.write(reused, () => {
        reused.fill('#');
        res.end();
      });
    });

    expect(served.body.toString('utf8')).toBe(REWRITTEN);
  });

  it('acknowledges write() asynchronously, so a callback-driven producer does not recurse', async () => {
    const chunks = 20_000;
    let syncAck = false;

    const served = await serve((res) => {
      let written = 0;

      const writeNext = () => {
        if (written === chunks) {
          res.end('</body></html>');

          return;
        }

        written += 1;

        let returned = false;

        res.write('a', () => {
          if (!returned) {
            syncAck = true;
          }

          writeNext();
        });
        returned = true;
      };

      res.write('<html><body>');
      writeNext();
    });

    expect(syncAck).toBe(false);
    expect(served.body.toString('utf8')).toBe(`<html><body>${'a'.repeat(chunks)}${PANEL}</body></html>`);
  });

  it('runs the callback passed to end()', async () => {
    const callback = vi.fn();

    await serve((res) => {
      res.end(ORIGINAL, callback);
    });

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('does not touch the headers once they are sent', async () => {
    const warn = vi.spyOn(createLogger(), 'warn').mockImplementation(() => {});
    const middleware = initRewriteResponse(() => true, injectPanel);
    const setHeader = vi.fn(() => {
      throw new Error('ERR_HTTP_HEADERS_SENT');
    });
    const end = vi.fn();
    const res = {
      headersSent: true,
      getHeader: (name: string) => (name === 'content-length' ? Buffer.byteLength(ORIGINAL) : undefined),
      setHeader,
      write: vi.fn(),
      end,
    };

    await middleware({ url: '/' } as any, res as any, () => res.end(ORIGINAL));

    expect(setHeader).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
    expect((end.mock.calls[0] as unknown[])[0]).toEqual(Buffer.from(REWRITTEN));
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
