import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequestCaptureMiddleware } from '../../../src/lib/request-capture.middleware.js';
import { RequestStore } from '../../../src/lib/request-store.js';

/**
 * Regression tests for the "capture middleware eats proxied request bodies" bug.
 *
 * The middleware previously attached a `req.on('data')` listener, which switched
 * the request stream into flowing mode. Buffered body chunks were emitted on
 * process.nextTick — before the (async) proxy middleware attached its pipe to the
 * backend — so PUT/POST bodies were lost and the backend answered 408 after
 * waiting for a body that never arrived. Capture must observe the stream without
 * changing its state: the body belongs to the downstream consumer.
 */

function makeReq(method = 'PUT', url = '/api/resource'): IncomingMessage {
  const req = new PassThrough() as unknown as IncomingMessage;

  req.method = method;
  req.url = url;
  req.headers = { 'content-type': 'application/json' };

  return req;
}

function makeRes(): ServerResponse {
  const res = new PassThrough() as unknown as ServerResponse;

  res.statusCode = 200;
  (res as any).getHeaders = () => ({});

  return res;
}

describe('createRequestCaptureMiddleware — stream neutrality', () => {
  it('does not switch the request stream into flowing mode', () => {
    const store = new RequestStore(1024 * 1024);
    const middleware = createRequestCaptureMiddleware(store);
    const req = makeReq();

    middleware(req, makeRes(), () => {});

    // A 'data' listener would set readableFlowing to true; the stream must stay paused.
    expect((req as unknown as PassThrough).readableFlowing).not.toBe(true);
  });

  it('delivers the full body to a late (next-tick) downstream consumer', async () => {
    const store = new RequestStore(1024 * 1024);
    const middleware = createRequestCaptureMiddleware(store);
    const req = makeReq();
    const body = JSON.stringify({ name: 'test', value: 42 });

    // Body is already buffered before any consumer attaches — the 408 scenario.
    (req as unknown as PassThrough).end(body);

    middleware(req, makeRes(), () => {});

    // The proxy attaches its pipe asynchronously (http-proxy-middleware is async).
    await new Promise((resolve) => setImmediate(resolve));

    const received: Buffer[] = [];
    const sink = new PassThrough();

    sink.on('data', (chunk: Buffer) => received.push(chunk));
    (req as unknown as PassThrough).pipe(sink);

    await new Promise((resolve) => sink.on('end', resolve));

    expect(Buffer.concat(received).toString()).toBe(body);
  });

  it('still captures the request body once a consumer reads the stream', async () => {
    const store = new RequestStore(1024 * 1024);
    const middleware = createRequestCaptureMiddleware(store);
    const req = makeReq();
    const res = makeRes();
    const body = JSON.stringify({ hello: 'world' });

    middleware(req, res, () => {});

    (req as unknown as PassThrough).end(body);

    // Downstream consumer drains the stream (as the proxy or a body parser would).
    (req as unknown as PassThrough).resume();
    await new Promise((resolve) => (req as unknown as PassThrough).on('end', resolve));

    // finalize() runs on res.end
    res.end();

    const entries = store.list({});

    expect(entries).toHaveLength(1);

    const entry = store.get(entries[0].id);

    expect(entry?.requestBody?.toString()).toBe(body);
  });
});
