/**
 * The parts of a dev server's setup that the Vite plugin (`pp-dev`) and `pp-dev next` share. Each
 * kept a copy, and the copies had started to differ (the index page regexp was escaped in one only).
 */
import type { Application } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ViteDevServer } from 'vite';
import type { MiAPI, MiAPIOptions } from './pp.middleware.js';
import { ClientService } from './client.service.js';
import type { DistService } from './dist.service.js';
import { registerVariablesEditorRoutes } from './variables-editor.js';
import { registerUserRoutes } from './user-routes.js';
import { registerLoginRoute } from './login-route.js';
import { startKeepingUsers } from './user-store.js';
import { createLogger } from './logger.js';
import { colors } from './helpers/color.helper.js';

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
 * Template sync over the WebSocket, the token login, Variables Editor and users routes, and the
 * saved users of this project and MI instance. Returns the ClientService, which the dev server
 * disposes of when it stops or restarts.
 */
export function startSyncAndUsers(opts: SyncAndUsersOptions): ClientService {
  const { distService, miAPI, persistUsers, projectRoot, miUrl } = opts;
  const clientService = new ClientService(opts.server, { distService, miAPI });

  registerLoginRoute(opts.internalServer, { miAPI, persistUsers, projectRoot, miUrl });
  registerVariablesEditorRoutes(opts.internalServer, { distService, miAPI });
  registerUserRoutes(opts.internalServer, { miAPI });
  startKeepingUsers({ persist: persistUsers, miAPI, projectRoot, miUrl });

  return clientService;
}

/** A middleware of the raw http server's chain, Connect-style: `next(error)` reports a failure. */
export type ChainMiddleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;

/**
 * Answers a request whose middleware failed, the way Vite's error middleware does for its server:
 * a 500 with the message. Without it, `pp-dev next` carried on to Next.js after an error (MI down,
 * a wrong `app.id`), rendering the page without its data and showing the error in the terminal only.
 */
export function respondToMiddlewareError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);

  createLogger().error(colors.red(`Request failed: ${message}`));

  if (res.writableEnded || res.destroyed) {
    return;
  }

  if (res.headersSent) {
    res.destroy();

    return;
  }

  res.statusCode = 500;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(message);
}

/**
 * Runs `chain` on a request of the raw http server, as Connect would: each middleware calls `next()`
 * for the following one, `done` runs after the last, and `next(error)` (or a throw) ends the request
 * with {@link respondToMiddlewareError} instead of being ignored.
 */
export function runMiddlewareChain(
  chain: readonly ChainMiddleware[],
  req: IncomingMessage,
  res: ServerResponse,
  done: () => void,
): void {
  let index = 0;

  const next = (error?: unknown) => {
    if (error) {
      respondToMiddlewareError(res, error);

      return;
    }

    if (index >= chain.length) {
      done();

      return;
    }

    const middleware = chain[index];

    index += 1;

    try {
      middleware(req, res, next);
    } catch (thrown) {
      respondToMiddlewareError(res, thrown);
    }
  };

  next();
}

/**
 * Ends a request to pp-dev's own routes (`/@api/*`, the inspector and editor pages) that none of
 * them answered: Express calls this when no route matches, or with the error a route failed with.
 * Under `pp-dev next` such requests used to hang, as the callback did nothing.
 */
export function endUnhandledInternalRequest(res: ServerResponse, error?: unknown): void {
  if (error) {
    respondToMiddlewareError(res, error);

    return;
  }

  if (res.headersSent || res.writableEnded) {
    return;
  }

  res.statusCode = 404;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: 'Not found' }));
}
