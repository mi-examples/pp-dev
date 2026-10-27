import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { respondToProxyError } from '../../../src/lib/proxy-pass.middleware.js';

/**
 * Regression tests for the proxy's error handler (MI unreachable, a reset connection, …).
 *
 * It sent the error's stack to the browser, called `writeHead` on responses whose headers were
 * already out (ERR_HTTP_HEADERS_SENT), and wrote to responses that had already ended
 * (ERR_STREAM_WRITE_AFTER_END). Both errors were thrown from the proxy's error callback.
 */

const upstreamError = () => {
  const error = new Error('connect ECONNREFUSED 10.0.0.1:443');

  error.stack = 'Error: connect ECONNREFUSED 10.0.0.1:443\n    at TCPConnectWrap.afterConnect (node:net:1)';

  return error;
};

type Outcome = { status?: number; body?: string; failed?: string; serverErrors: unknown[] };

/** Serves one request: `respond` gets the response, the client reports what it received. */
async function serve(respond: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Outcome> {
  const serverErrors: unknown[] = [];
  const server = http.createServer((req, res) => {
    res.on('error', (error) => serverErrors.push(error));

    try {
      respond(req, res);
    } catch (error) {
      serverErrors.push(error);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address() as AddressInfo;

  try {
    return await new Promise<Outcome>((resolve) => {
      const request = http.get({ host: '127.0.0.1', port, path: '/pl/page/', agent: false }, (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), serverErrors }),
        );
        res.on('error', (error) => resolve({ status: res.statusCode, failed: error.message, serverErrors }));
        res.on('aborted', () => resolve({ status: res.statusCode, failed: 'aborted', serverErrors }));
      });

      request.on('error', (error) => resolve({ failed: error.message, serverErrors }));
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('respondToProxyError', () => {
  it('answers 502 with a short message, keeping the stack in the log', async () => {
    const log = vi.fn();
    const outcome = await serve((req, res) => respondToProxyError(upstreamError(), req, res, log));

    expect(outcome.status).toBe(502);
    expect(outcome.body).toBe('Proxy error: "connect ECONNREFUSED 10.0.0.1:443" when trying to "GET /pl/page/"');
    expect(outcome.body).not.toContain('TCPConnectWrap');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('TCPConnectWrap.afterConnect'));
    expect(outcome.serverErrors).toEqual([]);
  });

  it('cuts the connection when the headers are already out, instead of throwing', async () => {
    const outcome = await serve((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': '1000' });
      res.write('<html><body>partial');
      respondToProxyError(upstreamError(), req, res, vi.fn());
    });

    // The client never gets a complete response: the connection drops, before or after the head.
    expect(outcome.body).toBeUndefined();
    expect(outcome.failed).toBeDefined();
    expect(outcome.serverErrors).toEqual([]);
  });

  it('leaves a response that has already ended alone', async () => {
    const outcome = await serve((req, res) => {
      res.end('done');
      respondToProxyError(upstreamError(), req, res, vi.fn());
    });

    expect(outcome.status).toBe(200);
    expect(outcome.body).toBe('done');
    // Give an asynchronous ERR_STREAM_WRITE_AFTER_END the chance to show up.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(outcome.serverErrors).toEqual([]);
  });

  it('closes the socket a WebSocket upgrade hands over instead of a response', () => {
    const socket = { destroy: vi.fn(), end: vi.fn(), write: vi.fn() };

    respondToProxyError(upstreamError(), { method: 'GET', url: '/ws' } as never, socket as unknown as Socket, vi.fn());

    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(socket.write).not.toHaveBeenCalled();
  });
});
