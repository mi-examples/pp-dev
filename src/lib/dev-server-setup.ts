/**
 * The parts of a dev server's setup that the Vite plugin (`pp-dev`) and `pp-dev next` share. Each
 * kept a copy, and the copies had started to differ (the index page regexp was escaped in one only).
 */
import type { Application } from 'express';
import type { ViteDevServer } from 'vite';
import type { MiAPI, MiAPIOptions } from './pp.middleware.js';
import { ClientService } from './client.service.js';
import type { DistService } from './dist.service.js';
import { registerVariablesEditorRoutes } from './variables-editor.js';
import { registerUserRoutes } from './user-routes.js';
import { startKeepingUsers } from './user-store.js';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** How long proxied MI responses are cached when `proxy.cacheTtl` isn't a positive number. */
export const DEFAULT_PROXY_CACHE_TTL_MS = 10 * 60 * 1000;

/** The MiAPI options for `backendBaseURL`: MI's host, referer and origin, and the page settings. */
export function getMiAPIOptions(
  backendBaseURL: string,
  settings: Omit<MiAPIOptions, 'headers' | 'personalAccessToken'> & { personalAccessToken?: string },
): MiAPIOptions & { headers: { host: string; referer: string; origin: string } } {
  return {
    headers: {
      host: new URL(backendBaseURL).host,
      referer: backendBaseURL,
      origin: backendBaseURL.replace(/^(https?:\/\/)([^/]+)(\/.*)?$/i, '$1$2'),
    },
    appId: settings.appId,
    templateLess: settings.templateLess,
    disableSSLValidation: settings.disableSSLValidation,
    v7Features: settings.v7Features,
    personalAccessToken: settings.personalAccessToken ?? process.env.MI_ACCESS_TOKEN,
  };
}

/** The proxy cache TTL in ms: `proxy.cacheTtl`, or {@link DEFAULT_PROXY_CACHE_TTL_MS} if it isn't usable. */
export function resolveProxyCacheTtl(cacheTtl: unknown): number {
  const ttl = Number(cacheTtl);

  return !ttl || Number.isNaN(ttl) || ttl < 0 ? DEFAULT_PROXY_CACHE_TTL_MS : ttl;
}

/** Matches the page's index: its base path, or `/`. The base is matched literally. */
export function getIndexPageRegExp(base: string): RegExp {
  return new RegExp(`^((${escapeRegExp(base)})|/)$`);
}

/** Paths the proxy never sends to MI: pp-dev's and Vite's own, and the page itself. */
export function getProxyIgnore(base: string): string[] {
  return ['/@vite', '/@metricinsights', '/@', base.endsWith('/') ? base.slice(0, -1) : base];
}

export interface SyncAndUsersOptions {
  /** The WebSocket side of the dev server (Vite's, or the `pp-dev next` stand-in). */
  server: ViteDevServer;
  internalServer: Application;
  distService: DistService;
  miAPI: MiAPI;
  persistUsers: boolean;
  projectRoot: string;
  miUrl: string;
}

/**
 * Template sync over the WebSocket, the Variables Editor and users routes, and the saved users of
 * this project and MI instance. Returns the ClientService, which the dev server disposes of when it
 * stops or restarts.
 */
export function startSyncAndUsers(opts: SyncAndUsersOptions): ClientService {
  const { distService, miAPI } = opts;
  const clientService = new ClientService(opts.server, { distService, miAPI });

  registerVariablesEditorRoutes(opts.internalServer, { distService, miAPI });
  registerUserRoutes(opts.internalServer, { miAPI });
  startKeepingUsers({ persist: opts.persistUsers, miAPI, projectRoot: opts.projectRoot, miUrl: opts.miUrl });

  return clientService;
}
