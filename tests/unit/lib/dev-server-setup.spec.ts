import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { ViteDevServer } from 'vite';
import http, { type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInternalServer } from '../../../src/lib/internal.middleware.js';
import {
  DEFAULT_PROXY_CACHE_TTL_MS,
  endUnhandledInternalRequest,
  getIndexPageRegExp,
  getMiAPIOptions,
  getProxyIgnore,
  resolveProxyCacheTtl,
  runMiddlewareChain,
  startSyncAndUsers,
  type ChainMiddleware,
} from '../../../src/lib/dev-server-setup.js';
import { ClientService } from '../../../src/lib/client.service.js';
import type { DistService } from '../../../src/lib/dist.service.js';
import type { MiAPI } from '../../../src/lib/pp.middleware.js';
import { createLogger } from '../../../src/lib/logger.js';
import { setEnvSwitchFailure } from '../../../src/lib/env-switch.js';

/** A response as the chain sees it: what was answered, and whether the headers are out. */
function makeRes() {
  const headers: Record<string, unknown> = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    body: undefined as string | undefined,
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = value;
    },
    end(chunk?: string) {
      res.headersSent = true;
      res.writableEnded = true;
      res.body = chunk;
    },
    destroy() {
      res.destroyed = true;
    },
    headers,
  };

  return res;
}

const req = {} as never;

/**
 * The setup the Vite plugin and `pp-dev next` share. Each kept a copy, and they had started to
 * differ: the Vite plugin matched the index page with the base path as a regexp.
 */
describe('dev server setup', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('getIndexPageRegExp', () => {
    it('matches the base path and /', () => {
      const regExp = getIndexPageRegExp('/pl/my-page/');

      expect(regExp.test('/pl/my-page/')).toBe(true);
      expect(regExp.test('/')).toBe(true);
      expect(regExp.test('/pl/my-page/other')).toBe(false);
    });

    // In the Vite plugin, `.` in a template name matched any character.
    it('matches the base path literally', () => {
      const regExp = getIndexPageRegExp('/pl/my.page+v2/');

      expect(regExp.test('/pl/my.page+v2/')).toBe(true);
      expect(regExp.test('/pl/myXpage+v2/')).toBe(false);
      expect(regExp.test('/pl/my.pageeev2/')).toBe(false);
    });
  });

  describe('resolveProxyCacheTtl', () => {
    it.each([
      [60_000, 60_000],
      ['5000', 5000],
    ])('takes %o as %o ms', (value, ttl) => {
      expect(resolveProxyCacheTtl(value)).toBe(ttl);
    });

    it.each([undefined, 0, -1, 'soon', Number.NaN])('falls back to 10 minutes for %o', (value) => {
      expect(resolveProxyCacheTtl(value)).toBe(DEFAULT_PROXY_CACHE_TTL_MS);
      expect(DEFAULT_PROXY_CACHE_TTL_MS).toBe(600_000);
    });
  });

  describe('getProxyIgnore', () => {
    it("keeps pp-dev's and Vite's own paths and the page itself from MI", () => {
      expect(getProxyIgnore('/pl/page/')).toEqual(['/@vite', '/@metricinsights', '/@', '/pl/page']);
      expect(getProxyIgnore('/pt/page')).toEqual(['/@vite', '/@metricinsights', '/@', '/pt/page']);
    });

    // With the plugin in a vite.config of its own (Vite's default base) the page is every path:
    // nothing is proxied, said so rather than by an empty prefix that happened to match everything.
    it('keeps every path from MI for a base of /', () => {
      expect(getProxyIgnore('/')).toEqual(['/@vite', '/@metricinsights', '/@', '/']);
    });
  });

  describe('getMiAPIOptions', () => {
    it("sends MI its own host, referer and origin, and the page's settings", () => {
      expect(
        getMiAPIOptions('https://mi.example.com/some/path', {
          appId: 7,
          templateLess: false,
          disableSSLValidation: true,
          v7Features: true,
          personalAccessToken: 'pat',
        }),
      ).toEqual({
        headers: {
          host: 'mi.example.com',
          referer: 'https://mi.example.com/some/path',
          origin: 'https://mi.example.com',
        },
        appId: 7,
        templateLess: false,
        disableSSLValidation: true,
        v7Features: true,
        personalAccessToken: 'pat',
      });
    });

    // PP-4840: the config resolves the token (MI_ACCESS_TOKEN for the default environment only). A
    // named environment without a token of its own must not get MI_ACCESS_TOKEN here, sent to its MI.
    it('does not take the token from MI_ACCESS_TOKEN when the config resolved none', () => {
      vi.stubEnv('MI_ACCESS_TOKEN', 'env-token');

      expect(getMiAPIOptions('https://mi.example.com', { templateLess: true }).personalAccessToken).toBeUndefined();
    });
  });

  describe('startSyncAndUsers', () => {
    it('starts template sync on the WebSocket and mounts the Variables Editor and users routes', () => {
      const handlers: string[] = [];
      const server = {
        ws: { on: vi.fn((event: string) => handlers.push(event)), send: vi.fn() },
        config: { clientInjectionPlugin: { v7Features: false } },
      } as unknown as ViteDevServer;
      const app = express();
      const clientService = startSyncAndUsers({
        server,
        internalServer: app,
        distService: {} as DistService,
        miAPI: {} as MiAPI,
        persistUsers: false,
        projectRoot: process.cwd(),
        miUrl: 'https://mi.example.com',
        envProtected: false,
        environments: [{ name: 'default', hasUrl: true, protected: false }],
      });
      const paths = (app.router.stack as Array<{ route?: { path: string } }>)
        .map((layer) => layer.route?.path)
        .filter(Boolean);

      expect(clientService).toBeInstanceOf(ClientService);
      expect(handlers).toContain('template:sync');
      expect(paths.some((path) => path!.startsWith('/@api/variables'))).toBe(true);
      expect(paths.some((path) => path!.startsWith('/@api/users'))).toBe(true);
      // The token login too: it was the Vite plugin's alone, and the form pp-dev adds to MI's login
      // page had no route to post to under `pp-dev next`.
      expect(paths).toContain('/@api/login');
    });

    // PP-4840 phase 2: `envProtected` reaches both writes to MI, the sync and the values save.
    it('makes a protected environment ask before a sync and a values save', async () => {
      const handlers = new Map<string, (...args: any[]) => any>();
      const server = {
        ws: { on: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)), send: vi.fn() },
        config: { clientInjectionPlugin: { v7Features: false } },
      } as unknown as ViteDevServer;
      const app = createInternalServer();
      const miAPI = { getAssets: vi.fn(), applyPageVariables: vi.fn() } as unknown as MiAPI;
      const clientService = startSyncAndUsers({
        server,
        internalServer: app,
        distService: { stopBuilds: vi.fn() } as unknown as DistService,
        miAPI,
        persistUsers: false,
        projectRoot: process.cwd(),
        miUrl: 'https://mi.example.com',
        envName: 'staging',
        appId: 42,
        envProtected: true,
        environments: [
          { name: 'default', hasUrl: true, protected: false },
          { name: 'staging', hasUrl: true, protected: true },
        ],
      });
      const httpServer = http.createServer(app);

      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));

      try {
        const { port } = httpServer.address() as AddressInfo;
        const res = await fetch(`http://127.0.0.1:${port}/@api/variables/values`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          // Loaded in this environment (PP-4840 phase 4: a save of another one's values is refused).
          body: JSON.stringify({
            tags: [{ name: 'a', value: '1' }],
            environment: 'staging https://mi.example.com 42',
          }),
        });

        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: 'PROTECTED_ENVIRONMENT', environment: 'staging' });

        // What the panel's switcher offers.
        const environment = await fetch(`http://127.0.0.1:${port}/@api/environment`).then((r) => r.json());

        expect(environment).toEqual({
          current: 'staging',
          environments: [
            { name: 'default', hasUrl: true, protected: false },
            { name: 'staging', hasUrl: true, protected: true },
          ],
          // No command registered a way to restart here.
          canSwitch: false,
        });

        // A server started again after a failed switch says why, for the tabs that wait for it.
        setEnvSwitchFailure({ name: 'default', error: 'it did not start' });

        try {
          const afterFailure = await fetch(`http://127.0.0.1:${port}/@api/environment`).then((r) => r.json());

          expect(afterFailure.failedSwitch).toEqual({ name: 'default', error: 'it did not start' });
        } finally {
          setEnvSwitchFailure(undefined);
        }
        expect(miAPI.applyPageVariables).not.toHaveBeenCalled();

        const client = { send: vi.fn() };
        const sync = handlers.get('template:sync')!({}, client);

        await vi.waitFor(() =>
          expect(client.send).toHaveBeenCalledWith(
            'template:sync:action-required',
            expect.objectContaining({ title: 'Protected MI environment', confirmText: 'Sync to staging' }),
          ),
        );
        expect(miAPI.getAssets).not.toHaveBeenCalled();

        clientService.dispose();
        await sync;
      } finally {
        clientService.dispose();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    });
  });

  // `pp-dev next` runs its middlewares on a raw http server. Its runner ignored the error a
  // middleware reports with `next(error)` and went on to Next.js, which rendered the page without
  // its data; the error showed in the terminal only.
  describe('runMiddlewareChain', () => {
    it('runs the middlewares in order, then `done`', () => {
      const calls: string[] = [];
      const chain: ChainMiddleware[] = [
        (_req, _res, next) => {
          calls.push('a');
          next();
        },
        (_req, _res, next) => {
          calls.push('b');
          next();
        },
      ];
      const res = makeRes();

      runMiddlewareChain(chain, req, res as unknown as ServerResponse, () => calls.push('done'));

      expect(calls).toEqual(['a', 'b', 'done']);
      expect(res.writableEnded).toBe(false);
    });

    it('runs `done` at once for an empty chain', () => {
      const done = vi.fn();

      runMiddlewareChain([], req, makeRes() as unknown as ServerResponse, done);

      expect(done).toHaveBeenCalledTimes(1);
    });

    it('answers 500 with the message of an error a middleware passes on, and stops', () => {
      vi.spyOn(createLogger(), 'error').mockImplementation(() => {});

      const after = vi.fn();
      const done = vi.fn();
      const chain: ChainMiddleware[] = [
        (_req, _res, next) => next(new Error('Request failed with status code 502')),
        after,
      ];
      const res = makeRes();

      runMiddlewareChain(chain, req, res as unknown as ServerResponse, done);

      expect(res.statusCode).toBe(500);
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(res.body).toBe('Request failed with status code 502');
      expect(after).not.toHaveBeenCalled();
      expect(done).not.toHaveBeenCalled();
    });

    it('answers 500 when a middleware throws', () => {
      vi.spyOn(createLogger(), 'error').mockImplementation(() => {});

      const res = makeRes();

      runMiddlewareChain(
        [
          () => {
            throw new Error('boom');
          },
        ],
        req,
        res as unknown as ServerResponse,
        vi.fn(),
      );

      expect(res.statusCode).toBe(500);
      expect(res.body).toBe('boom');
    });

    it('destroys a response whose headers are out instead of writing a second answer', () => {
      vi.spyOn(createLogger(), 'error').mockImplementation(() => {});

      const res = makeRes();

      res.headersSent = true;

      runMiddlewareChain(
        [(_req, _res, next) => next(new Error('late'))],
        req,
        res as unknown as ServerResponse,
        vi.fn(),
      );

      expect(res.destroyed).toBe(true);
      expect(res.body).toBeUndefined();
    });
  });

  // Express calls back when none of pp-dev's own routes matched; under `pp-dev next` that callback
  // did nothing, so `/@api/login` (then missing) and any mistyped `/@api/...` request hung.
  describe('endUnhandledInternalRequest', () => {
    it('answers 404 JSON when no route matched', () => {
      const res = makeRes();

      endUnhandledInternalRequest(res as unknown as ServerResponse);

      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toBe('application/json');
      expect(JSON.parse(res.body!)).toEqual({ error: 'Not found' });
    });

    it('answers 500 with the error a route failed with', () => {
      vi.spyOn(createLogger(), 'error').mockImplementation(() => {});

      const res = makeRes();

      endUnhandledInternalRequest(res as unknown as ServerResponse, new Error('route failed'));

      expect(res.statusCode).toBe(500);
      expect(res.body).toBe('route failed');
    });

    it('leaves a response a route already answered alone', () => {
      const res = makeRes();

      res.end('done');
      res.statusCode = 200;

      endUnhandledInternalRequest(res as unknown as ServerResponse);

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('done');
    });
  });
});
