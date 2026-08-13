import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { streamResponseInterceptor, PROXY_HEADER } from '../../../src/lib/proxy-pass.middleware.js';

/**
 * Regression tests for the "streamed responses are never rewritten" bug.
 *
 * `streamResponseInterceptor()` accepted an interceptor and then piped the upstream response
 * straight to the client without ever calling it, so the host rewriting applied to every
 * non-streaming response was silently skipped for `text/event-stream` (and for chunked
 * responses sent with `x-accel-buffering: no`). The upstream status code was dropped the same
 * way: a streamed 503 reached the browser as 200.
 *
 * Rewriting must still stay off compressed and non-textual payloads, whose bytes cannot be
 * decoded as text, and must survive a replaced value being split across two chunks.
 */

type ProxyRes = PassThrough & { headers: IncomingMessage['headers']; statusCode?: number; statusMessage?: string };

function makeProxyRes(headers: IncomingMessage['headers'], statusCode = 200, statusMessage?: string): ProxyRes {
  const proxyRes = new PassThrough() as ProxyRes;

  proxyRes.headers = headers;
  proxyRes.statusCode = statusCode;
  proxyRes.statusMessage = statusMessage;

  return proxyRes;
}

function makeRes() {
  const chunks: Buffer[] = [];
  const headers: Record<string, unknown> = {};

  const res = {
    statusCode: 200,
    statusMessage: '',
    headersSent: false,
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    write(chunk: Buffer | string) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

      return true;
    },
    end(chunk?: Buffer | string) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      res.finished = true;
    },
    on() {
      return res;
    },
    once() {
      return res;
    },
    emit() {
      return false;
    },
    finished: false,
    get body() {
      return Buffer.concat(chunks).toString('utf8');
    },
    headers,
  };

  return res;
}

const upstreamHost = 'mi.company.com';
const localHost = 'localhost:3000';

/** Same shape the proxy builds: replace the upstream host with the host the browser asked for. */
const hostRewriter = (data: Buffer, encoding: BufferEncoding) =>
  Buffer.from(data.toString(encoding).split(upstreamHost).join(localHost), encoding);

async function runStream(
  proxyRes: ProxyRes,
  res: ReturnType<typeof makeRes>,
  write: (stream: ProxyRes) => void,
  interceptor = hostRewriter,
) {
  await streamResponseInterceptor(interceptor)(
    proxyRes as unknown as IncomingMessage,
    {} as IncomingMessage,
    res as unknown as ServerResponse,
  );

  write(proxyRes);

  await new Promise((resolve) => setImmediate(resolve));
}

describe('streamResponseInterceptor', () => {
  it('applies the interceptor to a streamed text/event-stream body', async () => {
    const proxyRes = makeProxyRes({ 'content-type': 'text/event-stream' });
    const res = makeRes();

    await runStream(proxyRes, res, (stream) => {
      stream.end(`data: {"next":"https://${upstreamHost}/data/page/next"}\n\n`);
    });

    expect(res.body).toBe(`data: {"next":"https://${localHost}/data/page/next"}\n\n`);
    expect(res.getHeader(PROXY_HEADER)).toBe(1);
  });

  it('forwards the upstream status code and message', async () => {
    const proxyRes = makeProxyRes({ 'content-type': 'text/event-stream' }, 503, 'Service Unavailable');
    const res = makeRes();

    await runStream(proxyRes, res, (stream) => stream.end('data: down\n\n'));

    expect(res.statusCode).toBe(503);
    expect(res.statusMessage).toBe('Service Unavailable');
  });

  it('rewrites a value split across two chunks', async () => {
    const proxyRes = makeProxyRes({ 'content-type': 'text/event-stream' });
    const res = makeRes();

    await runStream(proxyRes, res, (stream) => {
      stream.write(`data: https://mi.com`);
      stream.end(`pany.com/data/page/next\n\n`);
    });

    expect(res.body).toBe(`data: https://${localHost}/data/page/next\n\n`);
  });

  it('forwards a complete event as soon as it arrives, without waiting for the stream to end', async () => {
    const proxyRes = makeProxyRes({ 'content-type': 'text/event-stream' });
    const res = makeRes();

    await runStream(proxyRes, res, (stream) => stream.write(`data: https://${upstreamHost}/a\n\n`));

    expect(res.body).toBe(`data: https://${localHost}/a\n\n`);
    expect(res.finished).toBe(false);

    proxyRes.end();
  });

  it('keeps multi-byte characters intact when a chunk splits them', async () => {
    const proxyRes = makeProxyRes({ 'content-type': 'text/event-stream' });
    const res = makeRes();
    const payload = Buffer.from('data: héllo\n\n', 'utf8');

    await runStream(proxyRes, res, (stream) => {
      // Split inside the two-byte "é".
      stream.write(payload.subarray(0, 7));
      stream.end(payload.subarray(7));
    });

    expect(res.body).toBe('data: héllo\n\n');
  });

  it('leaves a compressed stream untouched', async () => {
    const proxyRes = makeProxyRes({ 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
    const res = makeRes();
    const payload = `data: https://${upstreamHost}/a\n\n`;

    await runStream(proxyRes, res, (stream) => stream.end(payload));

    expect(res.body).toBe(payload);
  });

  it('leaves a non-textual stream untouched', async () => {
    const proxyRes = makeProxyRes({
      'content-type': 'application/octet-stream',
      'transfer-encoding': 'chunked',
      'x-accel-buffering': 'no',
    });
    const res = makeRes();
    const payload = `binary https://${upstreamHost}/a`;

    await runStream(proxyRes, res, (stream) => stream.end(payload));

    expect(res.body).toBe(payload);
  });

  it('pipes through when no interceptor is supplied', async () => {
    const proxyRes = makeProxyRes({ 'content-type': 'text/event-stream' });
    const res = makeRes();
    const payload = `data: https://${upstreamHost}/a\n\n`;

    await streamResponseInterceptor()(
      proxyRes as unknown as IncomingMessage,
      {} as IncomingMessage,
      res as unknown as ServerResponse,
    );

    proxyRes.end(payload);

    await new Promise((resolve) => setImmediate(resolve));

    expect(res.body).toBe(payload);
  });

  it('drops the upstream content-length when the body is rewritten', async () => {
    const proxyRes = makeProxyRes({ 'content-type': 'text/plain', 'content-length': '42' });
    const res = makeRes();

    await runStream(proxyRes, res, (stream) => stream.end(`https://${upstreamHost}/a\n`));

    expect(res.getHeader('content-length')).toBeUndefined();
    expect(res.getHeader('content-type')).toBe('text/plain');
  });

  it('keeps the upstream content-length when the body is passed through', async () => {
    const proxyRes = makeProxyRes({ 'content-type': 'application/octet-stream', 'content-length': '42' });
    const res = makeRes();

    await runStream(proxyRes, res, (stream) => stream.end('binary'));

    expect(res.getHeader('content-length')).toBe('42');
  });

  it('skips headers the upstream did not set', async () => {
    const proxyRes = makeProxyRes({ 'content-type': 'text/event-stream', 'x-missing': undefined });
    const res = makeRes();

    await runStream(proxyRes, res, (stream) => stream.end('data: ok\n\n'));

    expect('x-missing' in res.headers).toBe(false);
  });

  it('flushes a line that never breaks once it exceeds the pending limit', async () => {
    const proxyRes = makeProxyRes({ 'content-type': 'text/event-stream' });
    const res = makeRes();
    const long = `https://${upstreamHost}/${'a'.repeat(64 * 1024)}`;

    await runStream(proxyRes, res, (stream) => stream.write(long));

    expect(res.body).toBe(long.replace(upstreamHost, localHost));

    proxyRes.end();
  });
});
