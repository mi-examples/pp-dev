import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMiddlewareChain } from '../../../src/lib/middleware-chain.js';
import { createInternalServer } from '../../../src/lib/internal.middleware.js';
import { runMiddlewareChain } from '../../../src/lib/dev-server-setup.js';
import { invalidateProxyCache, onProxyCacheInvalidate } from '../../../src/lib/proxy-cache.middleware.js';
import { clearAPICache } from '../../../src/lib/load-pp-data.middleware.js';
import { getSessionCookieName } from '../../../src/lib/session-cookie.middleware.js';

/**
 * PP-4840 phase 3: the MI session cookie per MI instance on localhost. Two dev servers (one chain
 * per MI instance) and one browser cookie jar stand in for a switch between instances: each keeps
 * its login, and no instance ever gets another's session.
 */

const BASE = '/pl/cookie-app/';

function listen(server: http.Server) {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

/** An MI stand-in: `/login` hands out a new session, anything else says which cookie it got. */
function startMi(label: string) {
  let logins = 0;
  const received: (string | undefined)[] = [];
  const server = http.createServer((req, res) => {
    received.push(req.headers.cookie);

    if (req.url?.startsWith('/login')) {
      logins += 1;
      res.setHeader('set-cookie', [`metric_insights_session=${label}-${logins}; Path=/; HttpOnly`, 'other=1; Path=/']);
    }

    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
  });

  return { server, received };
}

/** The browser: one cookie jar for `localhost`, whatever the port. */
function createBrowser() {
  const jar = new Map<string, string>();

  return {
    jar,
    get(port: number, path: string) {
      return new Promise<{ status: number; setCookie: string[] }>((resolve, reject) => {
        const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

        http
          .request(
            {
              host: '127.0.0.1',
              port,
              path,
              headers: { host: `localhost:${port}`, ...(cookie ? { cookie } : {}) },
            },
            (res) => {
              const setCookie = res.headers['set-cookie'] ?? [];

              for (const value of setCookie) {
                const pair = value.split(';', 1)[0];
                const separator = pair.indexOf('=');

                jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
              }

              res.resume();
              res.on('end', () => resolve({ status: res.statusCode ?? 0, setCookie }));
            },
          )
          .on('error', reject)
          .end();
      });
    },
  };
}

describe('the MI session cookie per MI instance (PP-4840)', () => {
  const a = startMi('A');
  const b = startMi('B');
  let urlA: string;
  let urlB: string;
  const devServers: http.Server[] = [];

  /** A dev server for the instance at `url`, with `defaultUrl` the default environment's. */
  async function devServer(url: string, defaultUrl: string) {
    const chain = createMiddlewareChain({
      base: BASE,
      templateName: 'cookie-app',
      internalServer: createInternalServer(),
      backendBaseURL: url,
      sessionCookieName: getSessionCookieName(url, defaultUrl),
      mi: { appId: 1, templateLess: true, miHudLess: true, disableSSLValidation: false, v7Features: true },
      inspector: { enabled: false, maxMemory: 1024 * 1024, captureLimit: 64 * 1024 },
      proxy: { cache: true, cacheTtl: 60_000 },
      rewrite: () => ({ predicate: () => false, transform: (response) => response }),
    });
    const server = http.createServer((req, res) =>
      runMiddlewareChain(chain.main, req, res, () => {
        res.statusCode = 404;
        res.end();
      }),
    );

    devServers.push(server);

    return listen(server);
  }

  beforeAll(async () => {
    urlA = `http://127.0.0.1:${await listen(a.server)}`;
    urlB = `http://127.0.0.1:${await listen(b.server)}`;
  });

  afterAll(async () => {
    await Promise.all([a.server, b.server, ...devServers].map(close));
  });

  beforeEach(() => {
    a.received.length = 0;
    b.received.length = 0;
    invalidateProxyCache('test');
    clearAPICache();
  });

  it('keeps the login of each instance across switches, and never sends one to the other', async () => {
    const browser = createBrowser();
    const nameB = getSessionCookieName(urlB, urlA);
    // The default environment on A, a named one on B, as `pp-dev` and `pp-dev --env b` would run.
    const portA = await devServer(urlA, urlA);
    const portB = await devServer(urlB, urlA);

    expect(nameB).toBe(`metric_insights_session__127_0_0_1_${new URL(urlB).port}`);

    // Logged in on A: the default instance keeps MI's name.
    await browser.get(portA, '/login');
    expect(browser.jar.get('metric_insights_session')).toBe('A-1');

    // Switched to B: A's session is not sent there.
    await browser.get(portB, '/data/whoami');
    expect(b.received.at(-1)).toBe('other=1');

    // Logged in on B: kept apart.
    const login = await browser.get(portB, '/login');

    expect(login.setCookie.some((cookie) => cookie.startsWith(`${nameB}=B-1;`))).toBe(true);
    expect(browser.jar.get('metric_insights_session')).toBe('A-1');
    expect(browser.jar.get(nameB)).toBe('B-1');

    // Back on A, then B: each still logged in, with its own session under MI's name only.
    await browser.get(portA, '/data/whoami');
    await browser.get(portB, '/data/whoami');

    expect(a.received.at(-1)).toBe('metric_insights_session=A-1; other=1');
    expect(b.received.at(-1)).toBe('other=1; metric_insights_session=B-1');
  });

  it('shares the login between environments on one instance', async () => {
    const browser = createBrowser();
    // Two environments on B, neither of them the default one (on A): the same cookie.
    const port1 = await devServer(urlB, urlA);
    const port2 = await devServer(`${urlB}/`, urlA);

    await browser.get(port1, '/login');
    await browser.get(port2, '/data/whoami');

    expect(b.received.at(-1)).toMatch(/^metric_insights_session=B-\d+; other=1$/);
  });

  it('drops the cached responses on a login in a named environment, as in the default one', async () => {
    const browser = createBrowser();
    const port = await devServer(urlB, urlA);
    const reasons: string[] = [];
    const unsubscribe = onProxyCacheInvalidate(() => reasons.push('dropped'));

    try {
      await browser.get(port, '/data/whoami');
      await browser.get(port, '/login');

      expect(reasons.length).toBeGreaterThan(0);
    } finally {
      unsubscribe();
    }
  });
});
