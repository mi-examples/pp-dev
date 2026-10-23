import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { initProxyCache, invalidateProxyCache, cache } from '../../../src/lib/proxy-cache.middleware.js';
import { initProxy } from '../../../src/lib/proxy-pass.middleware.js';
import { UserRegistry } from '../../../src/lib/user-registry.js';
import { SessionUserTracker } from '../../../src/lib/session-users.js';
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

function request(
  port: number,
  path: string,
  host: string,
  cookie?: string,
  extraHeaders: http.OutgoingHttpHeaders = {},
) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = { host, ...extraHeaders };

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
  let releaseSlowAsset: (() => void) | undefined;
  const users = new UserRegistry();
  /** MI sessions that belong to an MI user; any other is a guest session. */
  const sessionOwners = new Map<string, { id: number; username: string }>();
  const miAPI = { v7Features: false, personalAccessToken: 'original-token' as string | undefined };

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      upstreamRequests.push({ url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie });

      if (req.url?.startsWith('/auth/index/logout')) {
        res.statusCode = 302;
        res.setHeader('location', '/login');
        res.setHeader('set-cookie', 'metric_insights_session=deleted; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT');
        res.end();

        return;
      }

      // MI answers every bearer request with a new session id, whatever cookie it received, and a
      // login with a new session too.
      if (req.headers.authorization || req.url === '/auth/login' || req.url === '/api/new-session') {
        res.setHeader('set-cookie', [
          `metric_insights_session=S${++sessionCounter}; path=/; httponly`,
          'theme=dark; path=/',
        ]);
      }

      if (req.url === '/login') {
        res.setHeader('content-type', 'text/html');
        res.end('<html><body>MI login</body></html>');

        return;
      }

      // An asset whose absolute URLs the proxy rewrites to the requesting host.
      if (req.url === '/assets/app.js') {
        res.setHeader('content-type', 'application/javascript');
        res.end(`fetch("http://${req.headers.host}/api/user")`);

        return;
      }

      // An asset MI answers only once the test lets it.
      if (req.url === '/assets/slow.png') {
        res.setHeader('content-type', 'text/plain');
        releaseSlowAsset = () => res.end(`slow as ${req.headers.authorization}`);

        return;
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
      sessionUsers: new SessionUserTracker(users, async (session) => sessionOwners.get(session)),
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
    sessionOwners.clear();
    upstreamRequests = [];
    sessionCounter = 0;
    releaseSlowAsset = undefined;
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
    expect(cache.keys().sort()).toEqual(['/assets/logo.png', '@viewer@viewer.localhost:3000:/assets/logo.png']);

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

  it("drops only that user's cache when a user's MI session changes", async () => {
    users.add({ name: 'viewer', kind: 'token', token: 'viewer-token' });
    users.add({ name: 'qa', kind: 'session' });

    await request(port, '/assets/logo.png', 'localhost:3000');
    await request(port, '/assets/logo.png', 'viewer.localhost:3000');
    await request(port, '/assets/logo.png', 'qa.localhost:3000', 'metric_insights_session=QA');
    await tick();

    expect(cache.keys()).toHaveLength(3);

    await request(port, '/auth/login', 'qa.localhost:3000', 'metric_insights_session=QA');
    await tick();

    expect(cache.keys().sort()).toEqual(['/assets/logo.png', '@viewer@viewer.localhost:3000:/assets/logo.png']);
  });

  describe('logout (PP-4599)', () => {
    beforeEach(() => {
      users.add({ name: 'viewer', kind: 'token', token: 'viewer-token' });
      users.add({ name: 'qa', kind: 'session' });
    });

    it('logs out at MI, drops the user and its cache, and sends the tab back to the main host', async () => {
      await request(port, '/assets/logo.png', 'localhost:3000');
      await request(port, '/assets/logo.png', 'viewer.localhost:3000');
      await request(port, '/assets/logo.png', 'qa.localhost:3000', 'metric_insights_session=QA');
      await tick();

      const res = await request(port, '/auth/index/logout', 'viewer.localhost:3000', undefined, {
        'sec-fetch-mode': 'navigate',
      });
      await tick();

      expect(upstreamRequests.at(-1)).toMatchObject({
        url: '/auth/index/logout',
        authorization: 'Bearer viewer-token',
      });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('http://localhost:3000/');
      expect(res.headers['set-cookie']).toEqual([expect.stringMatching(/^metric_insights_session=deleted;/)]);
      expect(users.get('viewer')).toBeUndefined();
      expect(cache.keys().sort()).toEqual(['/assets/logo.png', '@qa@qa.localhost:3000:/assets/logo.png']);
    });

    it('answers a logout made by a script with no content', async () => {
      const res = await request(port, '/auth/index/logout', 'qa.localhost:3000', 'metric_insights_session=QA', {
        'sec-fetch-mode': 'cors',
      });

      expect(upstreamRequests.at(-1)).toMatchObject({ authorization: undefined, cookie: 'metric_insights_session=QA' });
      expect(res.status).toBe(204);
      expect(users.get('qa')).toBeUndefined();
    });

    it('keeps the logout on the main host as it was', async () => {
      const res = await request(port, '/auth/index/logout?proxyRedirect=%2F', 'localhost:3000');

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/login');
      expect(users.list().map((user) => user.name)).toEqual(['viewer', 'qa']);
    });
  });

  describe('session users (PP-4596)', () => {
    it('notices a session user logging in on its own host', async () => {
      const qa = users.add({ name: 'qa', kind: 'session' });

      sessionOwners.set('S1', { id: 7, username: 'qa@example.com' });

      const res = await request(port, '/auth/login', 'qa.localhost:3000', 'metric_insights_session=GUEST');

      // The browser of the user's host keeps the session it logged in with.
      expect(res.headers['set-cookie']).toEqual([
        expect.stringMatching(/^metric_insights_session=S1;/),
        expect.stringMatching(/^theme=dark;/),
      ]);
      await vi.waitFor(() => expect(qa).toMatchObject({ state: 'active', session: 'S1', miUser: { id: 7 } }));
    });

    it('sends the main host as a default session user, and keeps the main host its own session', async () => {
      const qa = users.add({ name: 'qa', kind: 'session' });

      Object.assign(qa, { state: 'active', session: 'QA-SESSION' });
      users.setDefaultUser('qa');

      const res = await request(port, '/api/new-session', 'localhost:3000', 'metric_insights_session=MAIN; lang=en');

      expect(upstreamRequests.at(-1)).toMatchObject({
        authorization: undefined,
        cookie: 'lang=en; metric_insights_session=QA-SESSION',
      });
      expect(res.headers['set-cookie']).toEqual([expect.stringMatching(/^theme=dark;/)]);
    });

    it('leaves the token login form out of MI pages on a user host', async () => {
      users.add({ name: 'qa', kind: 'session' });

      const userHost = await request(port, '/login', 'qa.localhost:3000');
      const mainHost = await request(port, '/login', 'localhost:3000');

      expect(userHost.body).not.toContain('helper-login-wrapper');
      expect(mainHost.body).toContain('helper-login-wrapper');
    });
  });

  it("keeps a default user's entries for localhost apart from its own host's", async () => {
    users.add({ name: 'viewer', kind: 'token', token: 'viewer-token' });
    users.setDefaultUser('viewer');

    const onMain = await request(port, '/assets/app.js', 'localhost:3000');
    const onOwnHost = await request(port, '/assets/app.js', 'viewer.localhost:3000');

    expect(onMain.body).toContain('http://localhost:3000/api/user');
    expect(onOwnHost.headers['x-pp-cache']).toBeUndefined();
    expect(onOwnHost.body).toContain('http://viewer.localhost:3000/api/user');
  });

  it('does not let a response of a removed user refill the cache of the user added again', async () => {
    users.add({ name: 'viewer', kind: 'token', token: 'old-token' });

    const slow = request(port, '/assets/slow.png', 'viewer.localhost:3000');

    await vi.waitFor(() => expect(releaseSlowAsset).toBeDefined());

    users.remove('viewer');
    users.add({ name: 'viewer', kind: 'token', token: 'new-token' });
    releaseSlowAsset!();
    await slow;
    await tick();

    expect(cache.keys()).toEqual([]);

    releaseSlowAsset = undefined;

    const again = request(port, '/assets/slow.png', 'viewer.localhost:3000');

    await vi.waitFor(() => expect(releaseSlowAsset).toBeDefined());
    releaseSlowAsset!();

    expect((await again).body).toBe('slow as Bearer new-token');
  });

  it("drops a removed user's cache", async () => {
    users.add({ name: 'viewer', kind: 'token', token: 'viewer-token' });

    await request(port, '/assets/logo.png', 'localhost:3000');
    await request(port, '/assets/logo.png', 'viewer.localhost:3000');
    await tick();

    users.remove('viewer');

    expect(cache.keys()).toEqual(['/assets/logo.png']);
  });

  it('does not cache a user host with no saved user', async () => {
    await request(port, '/assets/logo.png', 'ghost.localhost:3000');
    await tick();

    expect(cache.keys()).toEqual([]);
  });
});
