import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { ViteDevServer } from 'vite';
import {
  DEFAULT_PROXY_CACHE_TTL_MS,
  getIndexPageRegExp,
  getMiAPIOptions,
  getProxyIgnore,
  resolveProxyCacheTtl,
  startSyncAndUsers,
} from '../../../src/lib/dev-server-setup.js';
import { ClientService } from '../../../src/lib/client.service.js';
import type { DistService } from '../../../src/lib/dist.service.js';
import type { MiAPI } from '../../../src/lib/pp.middleware.js';

/**
 * The setup the Vite plugin and `pp-dev next` share. Each kept a copy, and they had started to
 * differ: the Vite plugin matched the index page with the base path as a regexp.
 */
describe('dev server setup', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
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

    it('takes the token from MI_ACCESS_TOKEN when the config has none', () => {
      vi.stubEnv('MI_ACCESS_TOKEN', 'env-token');

      expect(getMiAPIOptions('https://mi.example.com', { templateLess: true }).personalAccessToken).toBe('env-token');
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
      });
      const paths = (app.router.stack as Array<{ route?: { path: string } }>)
        .map((layer) => layer.route?.path)
        .filter(Boolean);

      expect(clientService).toBeInstanceOf(ClientService);
      expect(handlers).toContain('template:sync');
      expect(paths.some((path) => path!.startsWith('/@api/variables'))).toBe(true);
      expect(paths.some((path) => path!.startsWith('/@api/users'))).toBe(true);
    });
  });
});
