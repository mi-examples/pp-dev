import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer, type Server } from 'http';
import { initLoadPPData, clearAPICache } from '../../../src/lib/load-pp-data.middleware.js';
import type { MiAPI } from '../../../src/lib/pp.middleware.js';

function createTestServer(middleware: any): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const next = () => {
        res.statusCode = 200;
        res.end('OK');
      };
      middleware(req, res, next);
    });

    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' ? (address?.port ?? 0) : 0;

      resolve({ server, port });
    });
  });
}

function makeRequest(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; location?: string }> {
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.request(
      { hostname: 'localhost', port, path, method: 'GET', headers, agent: false },
      (res: any) => {
        res.on('data', () => {});
        res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location }));
      },
    );
    req.end();
  });
}

const DOCUMENT_HEADERS = { accept: 'text/html', 'sec-fetch-dest': 'document' };
const SCRIPT_HEADERS = { accept: '*/*', 'sec-fetch-dest': 'script' };

/**
 * Regression tests for the bug where template variables were not loaded when the
 * first dev-server request was a deep-linked sub-path instead of the main page URL.
 */
describe('initLoadPPData — load on deep-linked sub-path navigation', () => {
  const APP_BASE = '/pl/foo/';
  const isIndexRegExp = new RegExp(`^((${APP_BASE})|/)$`);

  let mi: MiAPI;
  let getPageVariables: ReturnType<typeof vi.fn>;
  let getPageTemplate: ReturnType<typeof vi.fn>;

  function buildMiddleware() {
    return initLoadPPData(isIndexRegExp, mi, {
      appId: 123,
      templateLess: false,
      miHudLess: false,
      v7Features: true,
      appBase: APP_BASE,
    } as any);
  }

  beforeEach(() => {
    clearAPICache();

    getPageVariables = vi.fn().mockResolvedValue([]);
    getPageTemplate = vi.fn().mockResolvedValue('<html></html>');

    mi = { getPageVariables, getPageTemplate, getPageInfo: vi.fn().mockResolvedValue({}) } as unknown as MiAPI;
  });

  it('loads template variables for an HTML-document sub-path (the bug)', async () => {
    const { server, port } = await createTestServer(buildMiddleware());

    try {
      await makeRequest(port, '/pl/foo/dashboard/widget', DOCUMENT_HEADERS);

      expect(getPageVariables).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('loads template variables for the exact main page URL', async () => {
    const { server, port } = await createTestServer(buildMiddleware());

    try {
      await makeRequest(port, '/pl/foo/', DOCUMENT_HEADERS);

      expect(getPageVariables).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does NOT load for asset (non-document) requests under base', async () => {
    const { server, port } = await createTestServer(buildMiddleware());

    try {
      await makeRequest(port, '/pl/foo/assets/app.js', SCRIPT_HEADERS);

      expect(getPageVariables).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does NOT load for sub-paths outside the app base', async () => {
    const { server, port } = await createTestServer(buildMiddleware());

    try {
      await makeRequest(port, '/pl/other-app/dashboard', DOCUMENT_HEADERS);

      expect(getPageVariables).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/**
 * Regression tests for the login loop under `pp-dev next`: it passed no `appBase`, which counted as
 * "everything is under the base", so a navigation to MI's own `/login` loaded the page data too.
 * With an expired session that load failed, the middleware sent the browser back to MI, MI sent it
 * to `/login`, and so on without end: nobody could log in again.
 */
describe('initLoadPPData — navigations to MI pages outside the app', () => {
  const APP_BASE = '/pt/foo/';
  const isIndexRegExp = new RegExp(`^((${APP_BASE})|/)$`);
  const unauthorized = () => Promise.reject(Object.assign(new Error('Unauthorized'), { response: { status: 401 } }));

  let getPageVariables: ReturnType<typeof vi.fn>;

  function buildMiddleware(appBase: string | undefined) {
    getPageVariables = vi.fn(unauthorized);

    const mi = {
      getPageVariables,
      getPageTemplate: vi.fn(unauthorized),
      getPageInfo: vi.fn(unauthorized),
    } as unknown as MiAPI;

    // The options `pp-dev next` builds (`base` for its redirects), with and without `appBase`.
    return initLoadPPData(isIndexRegExp, mi, {
      appId: 123,
      templateLess: false,
      miHudLess: false,
      v7Features: true,
      base: APP_BASE,
      appBase,
    } as any);
  }

  beforeEach(() => {
    clearAPICache();
  });

  it('proxies /login as it is while the session is expired, instead of redirecting back (the loop)', async () => {
    const { server, port } = await createTestServer(buildMiddleware(APP_BASE));

    try {
      const response = await makeRequest(port, '/login', DOCUMENT_HEADERS);

      expect(response.status).toBe(200);
      expect(getPageVariables).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // A v7 app was sent to its own base path, which asked MI for the page data again, without end
  // (ERR_TOO_MANY_REDIRECTS): to MI's home, as any other, which sends the browser to the login.
  it('still answers the app itself with the redirect an expired session gets, to the login, not to itself', async () => {
    const { server, port } = await createTestServer(buildMiddleware(APP_BASE));

    try {
      const response = await makeRequest(port, '/pt/foo/dashboard', DOCUMENT_HEADERS);

      expect(response.status).toBe(302);
      expect(response.location).toBe('/home?proxyRedirect=%2F');
      expect(getPageVariables).toHaveBeenCalledTimes(1);

      const own = await makeRequest(port, APP_BASE, DOCUMENT_HEADERS);

      expect(own.status).toBe(302);
      expect(own.location).toBe('/home?proxyRedirect=%2F');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('counts no navigation as one into the app when no base is known', async () => {
    const { server, port } = await createTestServer(buildMiddleware(undefined));

    try {
      const response = await makeRequest(port, '/login', DOCUMENT_HEADERS);

      expect(response.status).toBe(200);
      expect(getPageVariables).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
