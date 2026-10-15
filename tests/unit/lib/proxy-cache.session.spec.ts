import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  initProxyCache,
  invalidateProxyCache,
  onProxyCacheInvalidate,
  cache,
} from '../../../src/lib/proxy-cache.middleware.js';
import { initProxy } from '../../../src/lib/proxy-pass.middleware.js';
import type { MiAPI } from '../../../src/lib/pp.middleware.js';

/**
 * Regression tests for PP-4238 follow-up: after logging in, logging out and logging in again with
 * an API token, some portal page images stayed broken until the cache expired.
 *
 * While logged out, MI answers portal page assets with a `302` to the login page. The proxy cache
 * stored that for every URL with a file extension, together with MI's `Set-Cookie`, and nothing
 * dropped it on login, so the browser kept getting the redirect (and the old session cookie) for
 * those assets after logging in.
 */

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

function listen(server: http.Server) {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function request(port: number, path: string, { method = 'GET', cookie }: { method?: string; cookie?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: cookie ? { cookie } : {} }, (res) => {
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

describe('proxy cache — MI session', () => {
  let upstream: http.Server;
  let proxy: http.Server;
  let port: number;
  let handler: Handler;
  let upstreamHits: string[];
  let upstreamAuth: (string | undefined)[];
  const miAPI = { v7Features: false, personalAccessToken: undefined as string | undefined };

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      upstreamHits.push(`${req.method} ${req.url}`);
      upstreamAuth.push(req.headers.authorization);
      handler(req, res);
    });

    const upstreamPort = await listen(upstream);

    const cacheMiddleware = initProxyCache({ devServer: {} as never });
    const proxyMiddleware = initProxy({
      baseURL: `http://127.0.0.1:${upstreamPort}`,
      devServer: {} as never,
      miAPI: miAPI as unknown as MiAPI,
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
    cache.clear();
    upstreamHits = [];
    upstreamAuth = [];
    miAPI.personalAccessToken = undefined;
  });

  const image: Handler = (req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.setHeader('set-cookie', 'metric_insights_session=A; path=/; httponly');
    res.end('image-bytes');
  };

  it('does not cache a redirect, so the asset loads once the user is logged in', async () => {
    handler = (req, res) => {
      res.statusCode = 302;
      res.setHeader('location', '/auth/saml/login');
      res.end('Redirecting to /auth/saml/login');
    };

    expect((await request(port, '/data/page/pp/assets/logo.png')).status).toBe(302);

    handler = image;

    const res = await request(port, '/data/page/pp/assets/logo.png');

    expect(res.status).toBe(200);
    expect(res.body).toBe('image-bytes');
    expect(upstreamHits).toHaveLength(2);
  });

  it('does not replay the Set-Cookie of a cached response', async () => {
    handler = image;

    const first = await request(port, '/assets/logo.png', { cookie: 'metric_insights_session=A' });
    const second = await request(port, '/assets/logo.png', { cookie: 'metric_insights_session=A' });

    expect(first.headers['set-cookie']).toEqual(['metric_insights_session=A; path=/; httponly']);
    expect(second.headers['x-pp-cache']).toBe('hit');
    expect(second.headers['set-cookie']).toBeUndefined();
    expect(second.body).toBe('image-bytes');
  });

  it('clears the cache when a response switches the browser to another MI session', async () => {
    handler = image;
    await request(port, '/assets/logo.png', { cookie: 'metric_insights_session=A' });
    await tick();

    handler = (req, res) => {
      res.statusCode = 302;
      res.setHeader('location', '/home');
      res.setHeader('set-cookie', 'metric_insights_session=B; path=/; httponly');
      res.end();
    };
    await request(port, '/auth/login', { method: 'POST', cookie: 'metric_insights_session=A' });
    await tick();

    expect(cache.keys()).toEqual([]);

    handler = image;
    await request(port, '/assets/logo.png', { cookie: 'metric_insights_session=B' });

    expect(upstreamHits.filter((hit) => hit === 'GET /assets/logo.png')).toHaveLength(2);
  });

  it('keeps the cache while the session id stays the same', async () => {
    handler = image;
    await request(port, '/assets/logo.png', { cookie: 'metric_insights_session=A' });
    await request(port, '/api/user', { cookie: 'metric_insights_session=A' });
    await tick();

    expect(cache.keys()).toEqual(['/assets/logo.png']);
  });

  describe('with a personal access token', () => {
    let sessionCounter: number;

    /** MI answers every bearer request with a new session id, whatever cookie it received. */
    const tokenImage: Handler = (req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.setHeader('set-cookie', `metric_insights_session=S${++sessionCounter}; path=/; httponly`);
      res.end('image-bytes');
    };

    beforeEach(() => {
      sessionCounter = 0;
      invalidateProxyCache('test setup');
      miAPI.personalAccessToken = 'token-1';
    });

    it('keeps the cache although MI hands every token request a new session id', async () => {
      handler = tokenImage;
      await request(port, '/assets/logo.png', { cookie: 'metric_insights_session=A' });
      await Promise.all([
        request(port, '/api/data_source_external_rollup', { cookie: 'metric_insights_session=A' }),
        request(port, '/data/document/global', { cookie: 'metric_insights_session=A' }),
        request(port, '/auth/get-license-info'),
      ]);
      await tick();

      expect(cache.keys()).toEqual(['/assets/logo.png']);

      const again = await request(port, '/assets/logo.png', { cookie: 'metric_insights_session=S1' });

      expect(again.headers['x-pp-cache']).toBe('hit');
      expect(upstreamHits.filter((hit) => hit === 'GET /assets/logo.png')).toHaveLength(1);
      expect(upstreamAuth.every((auth) => auth === 'Bearer token-1')).toBe(true);
    });

    it('does not notify listeners on ordinary token responses', async () => {
      let calls = 0;
      const unsubscribe = onProxyCacheInvalidate(() => calls++);

      handler = tokenImage;
      await request(port, '/api/user', { cookie: 'metric_insights_session=A' });
      await request(port, '/api/user', { cookie: 'metric_insights_session=A' });
      await tick();
      unsubscribe();

      expect(calls).toBe(0);
    });

    it('clears the cache when the personal access token changes', async () => {
      handler = tokenImage;
      await request(port, '/assets/logo.png');
      await tick();

      expect(cache.keys()).toEqual(['/assets/logo.png']);

      miAPI.personalAccessToken = 'token-2';
      await request(port, '/api/user');
      await tick();

      expect(cache.keys()).toEqual([]);
    });

    it('goes back to session tracking once the token is dropped', async () => {
      handler = tokenImage;
      await request(port, '/assets/logo.png', { cookie: 'metric_insights_session=A' });
      await tick();

      miAPI.personalAccessToken = undefined;
      await request(port, '/api/user', { cookie: 'metric_insights_session=A' });
      await tick();

      expect(cache.keys()).toEqual([]);
    });
  });

  it('does not cache non-GET requests', async () => {
    handler = image;
    await request(port, '/assets/upload.png', { method: 'POST', cookie: 'metric_insights_session=A' });

    expect(cache.keys()).toEqual([]);
  });

  it('notifies listeners when the cache is invalidated', () => {
    let calls = 0;
    const unsubscribe = onProxyCacheInvalidate(() => calls++);

    cache.put('/x.png', { headers: {}, content: Buffer.from('x'), timestamp: Date.now(), size: 1 });
    invalidateProxyCache('test');
    unsubscribe();
    invalidateProxyCache('test');

    expect(calls).toBe(1);
    expect(cache.keys()).toEqual([]);
  });
});
