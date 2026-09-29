import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { initLoadPPData, clearAPICache } from '../../../src/lib/load-pp-data.middleware.js';
import { authProvider } from '../../../src/lib/auth.provider.js';
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
