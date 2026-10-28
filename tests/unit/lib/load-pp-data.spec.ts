import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { initLoadPPData, clearAPICache } from '../../../src/lib/load-pp-data.middleware.js';
import { authProvider } from '../../../src/lib/auth.provider.js';
import { userRegistry } from '../../../src/lib/user-registry.js';
import { cache as proxyCache } from '../../../src/lib/proxy-cache.middleware.js';
import type { MiAPI } from '../../../src/lib/pp.middleware.js';

/**
 * Regression tests for PP-4238: after the regular login form, MI redirects to `/home`. When the
 * page data could not be loaded there (the session cookie was missing), the middleware answered
 * with a redirect to `/home?proxyRedirect=%2F` and then tried to redirect to the base as well,
 * which crashed the dev server with ERR_HTTP_HEADERS_SENT. It also left the session marked as
 * redirected, so every later `/home` was proxied straight to MI and the login looped.
 */

function makeRes() {
  const headers: Record<string, unknown> = {};

  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    setHeader(name: string, value: unknown) {
      if (res.headersSent) {
        const error = new Error('Cannot set headers after they are sent to the client') as Error & { code: string };

        error.code = 'ERR_HTTP_HEADERS_SENT';

        throw error;
      }

      headers[name.toLowerCase()] = value;
    },
    end() {
      res.headersSent = true;
      res.writableEnded = true;
    },
    headers,
  };

  return res;
}

function makeMi(getPageTemplate: () => Promise<unknown>) {
  return {
    getPageTemplate: vi.fn(getPageTemplate),
    getPageVariables: vi.fn(getPageTemplate),
    getPageInfo: vi.fn(getPageTemplate),
  } as unknown as MiAPI;
}

function makeReq(url: string) {
  return { url, headers: { accept: 'text/html', 'sec-fetch-dest': 'document' } } as never;
}

const unauthorized = () => Promise.reject(Object.assign(new Error('Unauthorized'), { response: { status: 401 } }));

describe('load-pp-data middleware — /home after login', () => {
  beforeEach(() => {
    authProvider.reset();
    clearAPICache();
  });

  it('answers once and keeps the session unredirected when the page data is unauthorized', async () => {
    const middleware = initLoadPPData(/^\/$/, makeMi(unauthorized), { templateLess: true });
    const res = makeRes();
    const next = vi.fn();

    await expect(middleware(makeReq('/home'), res as unknown as ServerResponse, next)).resolves.not.toThrow();

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/home?proxyRedirect=%2F');
    expect(next).not.toHaveBeenCalled();
    expect(authProvider.getState().isRedirected).toBe(false);
  });

  it('lets a later /home retry the load after a failed one', async () => {
    let authorized = false;
    const mi = makeMi(() => (authorized ? Promise.resolve({}) : unauthorized()));
    const middleware = initLoadPPData(/^\/$/, mi, { templateLess: true });

    await middleware(makeReq('/home'), makeRes() as unknown as ServerResponse, vi.fn());

    authorized = true;

    const res = makeRes();

    await middleware(makeReq('/home'), res as unknown as ServerResponse, vi.fn());

    expect(mi.getPageTemplate).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(authProvider.getState().isRedirected).toBe(true);
  });
});

/**
 * Regression tests for the proxy cache being dropped "after login" whenever the 3-minute page data
 * cache expired and a page was opened: every user's cached responses went, not only after a login.
 */
describe('load-pp-data middleware — proxy cache on login', () => {
  const CACHED_PATH = '/data/page/pp/assets/a.txt';

  beforeEach(() => {
    authProvider.reset();
    clearAPICache();
    proxyCache.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    proxyCache.clear();
  });

  const cacheResponse = () =>
    proxyCache.put(CACHED_PATH, { headers: {}, content: Buffer.from('x'), timestamp: Date.now(), size: 1 });

  it.each([
    ['page data', {}],
    ['page info', { templateLess: true, miHudLess: true, appId: 1 }],
  ])('drops the proxy cache on the first successful %s load', async (_name, opts) => {
    const middleware = initLoadPPData(
      /^\/$/,
      makeMi(() => Promise.resolve({})),
      opts,
    );

    cacheResponse();
    await middleware(makeReq('/'), makeRes() as unknown as ServerResponse, vi.fn());

    expect(proxyCache.get(CACHED_PATH)).toBeNull();
  });

  it.each([
    ['page data', {}],
    ['page info', { templateLess: true, miHudLess: true, appId: 1 }],
  ])('keeps the proxy cache when the %s is loaded again only because its cache expired', async (_name, opts) => {
    vi.useFakeTimers();

    const mi = makeMi(() => Promise.resolve({}));
    const middleware = initLoadPPData(/^\/$/, mi, opts);

    await middleware(makeReq('/'), makeRes() as unknown as ServerResponse, vi.fn());
    cacheResponse();

    vi.advanceTimersByTime(4 * 60 * 1000);
    await middleware(makeReq('/'), makeRes() as unknown as ServerResponse, vi.fn());

    const load = opts.appId ? mi.getPageInfo : mi.getPageTemplate;

    expect(load).toHaveBeenCalledTimes(2);
    expect(proxyCache.get(CACHED_PATH)).not.toBeNull();
  });

  it('drops the proxy cache again on a successful load after a failed one', async () => {
    let authorized = true;
    const mi = makeMi(() => (authorized ? Promise.resolve({}) : unauthorized()));
    const middleware = initLoadPPData(/^\/$/, mi, {});

    await middleware(makeReq('/'), makeRes() as unknown as ServerResponse, vi.fn());

    vi.useFakeTimers();
    vi.advanceTimersByTime(4 * 60 * 1000);
    authorized = false;
    await middleware(makeReq('/'), makeRes() as unknown as ServerResponse, vi.fn());

    cacheResponse();
    authorized = true;
    await middleware(makeReq('/'), makeRes() as unknown as ServerResponse, vi.fn());

    expect(mi.getPageTemplate).toHaveBeenCalledTimes(3);
    expect(proxyCache.get(CACHED_PATH)).toBeNull();
  });
});

describe("load-pp-data middleware — a saved user's host (PP-4594)", () => {
  beforeEach(() => {
    authProvider.reset();
    clearAPICache();
  });

  const pageRequest = (host: string) =>
    ({
      url: '/',
      headers: {
        host,
        accept: 'text/html',
        'sec-fetch-dest': 'document',
        cookie: 'metric_insights_session=X',
        authorization: 'Bearer page-token',
        token: 'regular-token',
      },
    }) as never;

  it("loads page data without the user host's MI session cookie or tokens", async () => {
    const mi = makeMi(() => Promise.resolve({}));
    const middleware = initLoadPPData(/^\/$/, mi, { templateLess: true });

    await middleware(pageRequest('viewer.localhost:3000'), makeRes() as unknown as ServerResponse, vi.fn());

    for (const header of ['cookie', 'authorization', 'token']) {
      expect(mi.getPageTemplate).toHaveBeenCalledWith(expect.not.objectContaining({ [header]: expect.anything() }));
    }
    expect(mi.getPageTemplate).toHaveBeenCalledWith(expect.objectContaining({ host: 'viewer.localhost:3000' }));
  });

  it('keeps the cookie on the main host', async () => {
    const mi = makeMi(() => Promise.resolve({}));
    const middleware = initLoadPPData(/^\/$/, mi, { templateLess: true });

    await middleware(pageRequest('localhost:3000'), makeRes() as unknown as ServerResponse, vi.fn());

    expect(mi.getPageTemplate).toHaveBeenCalledWith(expect.objectContaining({ cookie: 'metric_insights_session=X' }));
  });

  it("drops the page's tokens on the main host while a saved user is the default, keeping your cookie", async () => {
    userRegistry.add({ name: 'viewer', kind: 'token', token: 'viewer-token' });
    userRegistry.setDefaultUser('viewer');

    try {
      const mi = makeMi(() => Promise.resolve({}));
      const middleware = initLoadPPData(/^\/$/, mi, { templateLess: true });

      await middleware(pageRequest('localhost:3000'), makeRes() as unknown as ServerResponse, vi.fn());

      expect(mi.getPageTemplate).toHaveBeenCalledWith(expect.objectContaining({ cookie: 'metric_insights_session=X' }));

      for (const header of ['authorization', 'token']) {
        expect(mi.getPageTemplate).toHaveBeenCalledWith(expect.not.objectContaining({ [header]: expect.anything() }));
      }
    } finally {
      userRegistry.clear();
    }
  });
});

/**
 * Regression tests for the redirect loop on a failing MI: every error with an HTTP response (a 5xx,
 * MI's HTML maintenance page) counted as "not authorized", so the page was redirected to
 * `/home?proxyRedirect=%2F`, whose injected script led back to the page after 3 seconds, which
 * failed again. Only 401, 403 and 412 are about the session or token; anything else must reach
 * the error handler so the developer sees it.
 */
describe('load-pp-data middleware — MI errors that are not about authorization', () => {
  const httpError = (status: number, data: unknown = { message: 'error' }) =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
      isAxiosError: true,
      response: { status, data },
    });

  beforeEach(() => {
    authProvider.reset();
    clearAPICache();
  });

  it.each([401, 403, 412])('sends a page load MI refused with %i to the login flow', async (status) => {
    const middleware = initLoadPPData(
      /^\/$/,
      makeMi(() => Promise.reject(httpError(status))),
      { templateLess: true },
    );
    const res = makeRes();
    const next = vi.fn();

    await middleware(makeReq('/'), res as unknown as ServerResponse, next);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/home?proxyRedirect=%2F');
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ['a 500 with an HTML error page', httpError(500, '<!DOCTYPE html><html><body>Internal Server Error</body></html>')],
    ['a 502', httpError(502)],
    ['a 503 maintenance page', httpError(503, '<html><body>Down for maintenance</body></html>')],
    ['a 504', httpError(504)],
    ['a 400', httpError(400)],
    ['a network error', Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' })],
  ])('passes %s from MI on as an error instead of redirecting to the login flow', async (_name, error) => {
    const middleware = initLoadPPData(
      /^\/$/,
      makeMi(() => Promise.reject(error)),
      { templateLess: true },
    );
    const res = makeRes();
    const next = vi.fn();

    await middleware(makeReq('/'), res as unknown as ServerResponse, next);

    expect(res.headers.location).toBeUndefined();
    expect(res.headersSent).toBe(false);
    expect(next).toHaveBeenCalledWith(error);
  });

  it('passes an MI failure on /home on as an error, not as a successful login', async () => {
    const error = httpError(503, '<html><body>Down for maintenance</body></html>');
    const middleware = initLoadPPData(
      /^\/$/,
      makeMi(() => Promise.reject(error)),
      { templateLess: true },
    );
    const res = makeRes();
    const next = vi.fn();

    await middleware(makeReq('/home'), res as unknown as ServerResponse, next);

    expect(res.headers.location).toBeUndefined();
    expect(next).toHaveBeenCalledWith(error);
    expect(authProvider.getState().isRedirected).toBe(false);
  });
});
