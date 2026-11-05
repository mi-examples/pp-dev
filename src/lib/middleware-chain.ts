/**
 * The request pipeline of a pp-dev dev server, built once for both servers: the Vite plugin
 * (`pp-dev`) mounts it on Vite's Connect app, `pp-dev next` runs it on its raw http server before
 * Next.js. Each used to assemble its own copy, and the copies had drifted: the index regexp, the
 * `appBase` and `base` the page-data load got, where pp-dev's own routes were mounted, the error
 * handling (§7.3 #2, #6, #7 of the improvement proposals).
 */
import type { Application } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, ViteDevServer } from 'vite';
import { MiAPI } from './pp.middleware.js';
import { initPPRedirect } from './pp-redirect.middleware.js';
import { initProxyCache } from './proxy-cache.middleware.js';
import proxyPassMiddleware from './proxy-pass.middleware.js';
import { initLoadPPData } from './load-pp-data.middleware.js';
import { initRewriteResponse, type RewriteResponseOptions } from './rewrite-response.middleware.js';
import { createRequestCaptureMiddleware } from './request-capture.middleware.js';
import { registerInspectorRoutes, INSPECTOR_PATH } from './request-inspector.js';
import { RequestStore } from './request-store.js';
import { createUserHostGuard } from './user-registry.js';
import { createDevPanelAssetMiddleware } from './dev-panel.js';
import { VARIABLES_EDITOR_PATH } from './variables-editor.js';
import {
  type ChainMiddleware,
  endUnhandledInternalRequest,
  getIndexPageRegExp,
  getMiAPIOptions,
  getProxyIgnore,
  resolveProxyCacheTtl,
} from './dev-server-setup.js';

/** How the page that goes to the browser is rewritten: which responses, and into what. */
export interface PageRewrite {
  /** By the request URL; the response's type can still rule it out (`contentType`). */
  predicate: (url: string, req: IncomingMessage) => boolean;
  transform: (response: Buffer, req: IncomingMessage) => Buffer;
  contentType?: RewriteResponseOptions['contentType'];
}

export interface MiddlewareChainOptions {
  /** The app's base path, as the server knows it (`/pl/<name>` or `/pl/<name>/`). */
  base: string;
  templateName: string;
  /** pp-dev's own routes (`/@api/*`, the inspector and editor pages); the caller registers more on it. */
  internalServer: Application;
  /** MI; without it the chain has no proxy, no page data and no rewrite. */
  backendBaseURL?: string;
  mi: {
    appId?: number;
    templateLess: boolean;
    miHudLess: boolean;
    disableSSLValidation: boolean;
    v7Features: boolean;
    personalAccessToken?: string;
  };
  inspector: { enabled: boolean; maxMemory: number; captureLimit: number };
  proxy: {
    cache: boolean;
    cacheTtl: unknown;
    /** Paths never sent to MI, besides pp-dev's and Vite's own and the page itself. */
    ignore?: string[];
    /** Gets the proxy cache as `cache`, where a server is there to take it. */
    devServer?: ViteDevServer;
  };
  /** Serve the dev panel's `client.js` / `client.css` from the chain (Vite serves them itself). */
  devPanelAssets?: boolean;
  /** The page rewrite, given the MI client and MI's host (for rewriting MI's URLs to the dev server's). */
  rewrite: (mi: MiAPI, baseUrlHost: string) => PageRewrite;
}

export interface MiddlewareChain {
  /** Every middleware but the rewrite, in order: the chain of a page request. */
  main: ChainMiddleware[];
  /** What a request for a bundler's own file goes through (`/_next/*`): no proxy, no page data. */
  essential: ChainMiddleware[];
  /** Runs last, over the response the renderer gives; `null` without a backend. */
  rewrite: ChainMiddleware | null;
  mi: MiAPI | null;
  /** The proxy cache's TTL in ms, or `null` when the cache is off. */
  proxyCacheTtl: number | null;
}

/** The Connect middlewares take Connect's request; the chain gives them the raw one, which they read alike. */
const asChain = (middleware: Connect.NextHandleFunction): ChainMiddleware => middleware as unknown as ChainMiddleware;

/**
 * Builds the chain. In order: the user-host guard (a user host with no saved user behind it gets
 * nothing), the Request Inspector's capture, pp-dev's redirects, the dev panel's assets, the proxy
 * cache, the page-data load, the proxy to MI, pp-dev's own routes; the rewrite apart, as the last
 * one. The parts without a backend: the capture, the redirects and pp-dev's own routes.
 */
export function createMiddlewareChain(options: MiddlewareChainOptions): MiddlewareChain {
  const { base, templateName, internalServer, backendBaseURL, inspector, proxy } = options;
  const main: ChainMiddleware[] = [];
  const essential: ChainMiddleware[] = [];

  if (backendBaseURL) {
    const userHostGuard = asChain(createUserHostGuard());

    main.push(userHostGuard);
    essential.push(userHostGuard);
  }

  if (inspector.enabled) {
    const reqStore = new RequestStore(inspector.maxMemory);

    registerInspectorRoutes(internalServer, reqStore, inspector.captureLimit);
    main.push(asChain(createRequestCaptureMiddleware(reqStore, inspector.captureLimit)));
  }

  const redirect = asChain(initPPRedirect(base, templateName));

  main.push(redirect);
  essential.push(redirect);

  if (options.devPanelAssets) {
    const devPanelAssets = createDevPanelAssetMiddleware(base);

    main.push(devPanelAssets);
    essential.push(devPanelAssets);
  }

  let mi: MiAPI | null = null;
  let proxyCacheTtl: number | null = null;
  let rewrite: ChainMiddleware | null = null;

  if (backendBaseURL) {
    const miConfig = getMiAPIOptions(backendBaseURL, options.mi);

    mi = new MiAPI(backendBaseURL, miConfig);

    if (proxy.cache) {
      proxyCacheTtl = resolveProxyCacheTtl(proxy.cacheTtl);
      main.push(asChain(initProxyCache({ devServer: proxy.devServer, ttl: proxyCacheTtl })));
    }

    // Before the proxy, so the v7 internal page name is there for the `/data/page/` rewrites.
    // `appBase`: only a navigation into the app loads the page data, not MI's own `/login`;
    // `base`: where a v7 page goes after MI turned its data load down.
    main.push(
      asChain(
        initLoadPPData(getIndexPageRegExp(base), mi, {
          ...options.mi,
          base,
          appBase: base,
        }),
      ),
    );

    main.push(
      asChain(
        proxyPassMiddleware({
          devServer: proxy.devServer,
          baseURL: backendBaseURL,
          proxyIgnore: [...getProxyIgnore(base), ...(proxy.ignore ?? [])],
          disableSSLValidation: options.mi.disableSSLValidation,
          miAPI: mi,
          templateName,
        }),
      ),
    );

    const page = options.rewrite(mi, new URL(backendBaseURL).host);

    rewrite = asChain(
      initRewriteResponse(
        (url, req) => page.predicate(url, req),
        (response, req) => page.transform(response, req),
        page.contentType ? { contentType: page.contentType } : {},
      ),
    );
  }

  // pp-dev's own routes, after the proxy (which leaves `/@…` alone) and before the rewrite. Only
  // their paths go to the Express app: mounted for every path, its body parsers would read a
  // request's body before the proxy could pipe it to MI (which then waited for one and answered
  // 408). And through a wrapper, not the app itself: Vite sets a `.route` string on what it
  // mounts, which overwrote Express's `app.route()`, and a route registered after that crashed.
  // Express calls back when no route matched or one failed; the callback ends the request.
  if (inspector.enabled || backendBaseURL) {
    const internal: ChainMiddleware = (req, res, next) => {
      const url = req.url ?? '';

      if (url.startsWith('/@api/') || url.startsWith(INSPECTOR_PATH) || url.startsWith(VARIABLES_EDITOR_PATH)) {
        internalServer(req as never, res as never, (error?: unknown) => endUnhandledInternalRequest(res, error));

        return;
      }

      next();
    };

    main.push(internal);
    essential.push(internal);
  }

  return { main, essential, rewrite, mi, proxyCacheTtl };
}

/** Mounts the chain on Vite's Connect app; the rewrite is for the plugin's post hook. */
export function mountMiddlewareChain(server: Pick<ViteDevServer, 'middlewares'>, chain: MiddlewareChain): void {
  for (const middleware of chain.main) {
    server.middlewares.use(middleware as unknown as Connect.NextHandleFunction);
  }
}

export type { ServerResponse };
