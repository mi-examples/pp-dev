import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { initProxy } from '../../../src/lib/proxy-pass.middleware.js';
import { UserRegistry } from '../../../src/lib/user-registry.js';
import { SessionUserTracker } from '../../../src/lib/session-users.js';
import { OriginalSession } from '../../../src/lib/original-session.js';
import type { MiAPI } from '../../../src/lib/pp.middleware.js';
import type { MiUser } from '../../../src/lib/mi-identity.js';

/**
 * PP-4602: without an API token, the proxy follows the MI session of the main host (`localhost`),
 * which is the original user's: only there, and only for requests that went as the original user.
 */

function listen(server: http.Server) {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function request(port: number, path: string, host: string, session?: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = { host };

    if (session) {
      headers.cookie = `metric_insights_session=${session}`;
    }

    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });

    req.on('error', reject);
    req.end();
  });
}

describe('proxy — the original user from a login on localhost', () => {
  let upstream: http.Server;
  let proxy: http.Server;
  let port: number;
  const users = new UserRegistry();
  const original = new OriginalSession();
  const owners = new Map<string, MiUser>();
  const check = vi.fn(async (session: string) => owners.get(session));
  const miAPI = { v7Features: false, personalAccessToken: undefined as string | undefined };

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      // A login hands out a new session; a logout ends it.
      if (req.url === '/login') {
        res.statusCode = 302;
        res.setHeader('location', '/home');
        res.setHeader('set-cookie', 'metric_insights_session=S1; path=/; httponly');
      } else if (req.url?.startsWith('/auth/index/logout')) {
        res.statusCode = 302;
        res.setHeader('location', '/login');
        res.setHeader('set-cookie', 'metric_insights_session=G2; path=/; httponly');
      }

      res.setHeader('content-type', 'text/plain');
      res.end('ok');
    });

    const upstreamPort = await listen(upstream);
    const proxyMiddleware = initProxy({
      baseURL: `http://127.0.0.1:${upstreamPort}`,
      miAPI: miAPI as unknown as MiAPI,
      users,
      sessionUsers: new SessionUserTracker(users, async () => undefined),
      originalSession: original,
    });

    proxy = http.createServer((req, res) => {
      proxyMiddleware(req as never, res, () => {
        res.statusCode = 404;
        res.end();
      });
    });

    port = await listen(proxy);
  });

  afterAll(async () => {
    await close(proxy);
    await close(upstream);
  });

  beforeEach(() => {
    users.clear();
    original.clear();
    original.useCheck(check);
    owners.clear();
    owners.set('S1', { id: 7, username: 'dev' });
    check.mockClear();
    miAPI.personalAccessToken = undefined;
  });

  it('takes the session of a login on the main host', async () => {
    await request(port, '/login', 'localhost:3000', 'G1');

    await vi.waitFor(() => expect(original.session).toBe('S1'));
    expect(original.miUser).toEqual({ id: 7, username: 'dev' });
  });

  it('takes the session the main host carries', async () => {
    await request(port, '/home', 'localhost:3000', 'S1');

    await vi.waitFor(() => expect(original.session).toBe('S1'));
  });

  it("leaves a saved user's host alone", async () => {
    users.add({ name: 'qa', kind: 'session' });

    await request(port, '/home', 'qa.localhost:3000', 'S1');

    expect(check).not.toHaveBeenCalled();
    expect(original.state).toBe('none');
  });

  it('leaves the main host alone while a saved user is its default', async () => {
    users.add({ name: 'viewer', kind: 'token', token: 'viewer-token' });
    users.setDefaultUser('viewer');

    await request(port, '/home', 'localhost:3000', 'S1');

    expect(check).not.toHaveBeenCalled();
  });

  it('leaves an IP address alone: it has cookies of its own', async () => {
    await request(port, '/home', `127.0.0.1:${port}`, 'S1');

    expect(check).not.toHaveBeenCalled();
  });

  it('leaves the session alone with an API token, which is the original user then', async () => {
    miAPI.personalAccessToken = 'original-token';

    await request(port, '/login', 'localhost:3000', 'G1');

    expect(check).not.toHaveBeenCalled();
  });

  it('leaves a request with credentials of its own alone: MI answers it as their owner', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/login',
          headers: { host: 'localhost:3000', authorization: 'Bearer page-token' },
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );

      req.on('error', reject);
      req.end();
    });

    expect(check).not.toHaveBeenCalled();
  });

  it('ends the session on a logout on the main host', async () => {
    await request(port, '/home', 'localhost:3000', 'S1');
    await vi.waitFor(() => expect(original.session).toBe('S1'));

    await request(port, '/auth/index/logout', 'localhost:3000', 'S1');

    expect(original.state).toBe('expired');
    expect(original.session).toBeUndefined();
  });
});
