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

function makeRequest(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number }> {
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.request({ hostname: 'localhost', port, path, method: 'GET', headers }, (res: any) => {
      res.on('data', () => {});
      res.on('end', () => resolve({ status: res.statusCode }));
    });
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
