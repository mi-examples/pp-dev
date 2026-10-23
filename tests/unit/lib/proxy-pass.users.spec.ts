import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { initProxyCache, invalidateProxyCache, cache } from '../../../src/lib/proxy-cache.middleware.js';
import { initProxy } from '../../../src/lib/proxy-pass.middleware.js';
import { UserRegistry } from '../../../src/lib/user-registry.js';
import type { MiAPI } from '../../../src/lib/pp.middleware.js';

/**
 * PP-4594: every saved user has its own host (`<name>.localhost`), and the proxy sends MI requests
 * from that host as that user: a token user with its own token, a session user with nothing but the
 * MI session its host's cookies carry. The original user (the configured token) keeps the main host.
 */

function listen(server: http.Server) {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function request(port: number, path: string, host: string, cookie?: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = { host };

    if (cookie) {
      headers.cookie = cookie;
    }

    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks: Buffer[] = [];

      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
      );
    });

    req.on('error', reject);
    req.end();
  });
}

/** Resolves once the proxy cache has handled the `finish` of the last response. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('proxy — saved users', () => {
  let upstream: http.Server;
  let proxy: http.Server;
  let port: number;
  let upstreamRequests: { url?: string; authorization?: string; cookie?: string }[];
  let sessionCounter: number;
  const users = new UserRegistry();
  const miAPI = { v7Features: false, personalAccessToken: 'original-token' as string | undefined };

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      upstreamRequests.push({ url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie });

      // MI answers every bearer request with a new session id, whatever cookie it received.
      if (req.headers.authorization) {
        res.setHeader('set-cookie', `metric_insights_session=S${++sessionCounter}; path=/; httponly`);
      }

      res.setHeader('content-type', 'text/plain');
      res.end(`as ${req.headers.authorization ?? req.headers.cookie ?? 'nobody'}`);
    });

    const upstreamPort = await listen(upstream);

    const cacheMiddleware = initProxyCache({ devServer: {} as never, users });
    const proxyMiddleware = initProxy({
      baseURL: `http://127.0.0.1:${upstreamPort}`,
      devServer: {} as never,
      miAPI: miAPI as unknown as MiAPI,
      users,
    });

    proxy = http.createServer((req, res) => {
      const notFound = () => {
        res.statusCode = 404;
        res.end();
      };

      cacheMiddleware(req as never, res, () => proxyMiddleware(req as never, res, notFound));
    });

    port = await listen(proxy);
  });

  afterAll(async () => {
    await close(proxy);
    await close(upstream);
  });

  beforeEach(() => {
    invalidateProxyCache('test setup');
    users.clear();
    upstreamRequests = [];
    sessionCounter = 0;
    miAPI.personalAccessToken = 'original-token';
  });

  it('sends the main host as the original user', async () => {
    await request(port, '/api/user', 'localhost:3000');

    expect(upstreamRequests[0].authorization).toBe('Bearer original-token');
  });

  it("sends a token user's host with that user's token", async () => {
    users.add({ name: 'viewer', kind: 'token', token: 'viewer-token' });

    const res = await request(port, '/api/user', 'viewer.localhost:3000');

    expect(res.body).toBe('as Bearer viewer-token');
    expect(upstreamRequests[0].authorization).toBe('Bearer viewer-token');
  });

  it("sends a session user's host with its own cookies and no token", async () => {
    users.add({ name: 'qa', kind: 'session' });

    await request(port, '/api/user', 'qa.localhost:3000', 'metric_insights_session=QA');

    expect(upstreamRequests[0]).toMatchObject({ authorization: undefined, cookie: 'metric_insights_session=QA' });
  });

  it('sends a user host with no saved user with no token', async () => {
    await request(port, '/api/user', 'ghost.localhost:3000');

    expect(upstreamRequests[0].authorization).toBeUndefined();
  });

  it('sends the main host as the default user', async () => {
    users.add({ name: 'viewer', kind: 'token', token: 'viewer-token' });
    users.setDefaultUser('viewer');

    await request(port, '/api/user', 'localhost:3000');

    expect(upstreamRequests[0].authorization).toBe('Bearer viewer-token');
  });

  it('never serves one user what MI answered another', async () => {
    users.add({ name: 'viewer', kind: 'token', token: 'viewer-token' });

    const original = await request(port, '/assets/logo.png', 'localhost:3000');
    const viewer = await request(port, '/assets/logo.png', 'viewer.localhost:3000');
    await tick();

    expect(original.body).toBe('as Bearer original-token');
    expect(viewer.body).toBe('as Bearer viewer-token');
    expect(viewer.headers['x-pp-cache']).toBeUndefined();
    expect(cache.keys().sort()).toEqual(['/assets/logo.png', '@viewer:/assets/logo.png']);

    const viewerAgain = await request(port, '/assets/logo.png', 'viewer.localhost:3000');
    const originalAgain = await request(port, '/assets/logo.png', 'localhost:3000');

    expect(viewerAgain).toMatchObject({ body: 'as Bearer viewer-token', headers: { 'x-pp-cache': 'hit' } });
    expect(originalAgain).toMatchObject({ body: 'as Bearer original-token', headers: { 'x-pp-cache': 'hit' } });
  });

  it('keeps the cache while requests of different token users interleave', async () => {
    users.add({ name: 'viewer', kind: 'token', token: 'viewer-token' });

    await request(port, '/assets/logo.png', 'localhost:3000');
    await request(port, '/assets/logo.png', 'viewer.localhost:3000');
    await request(port, '/api/user', 'localhost:3000');
    await request(port, '/api/user', 'viewer.localhost:3000');
    await tick();

    expect(cache.keys()).toHaveLength(2);
  });

  it('does not cache a user host with no saved user', async () => {
    await request(port, '/assets/logo.png', 'ghost.localhost:3000');
    await tick();

    expect(cache.keys()).toEqual([]);
  });
});
