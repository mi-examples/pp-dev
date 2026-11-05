import type { Environment, IndexHtmlTransformResult, Plugin } from 'vite';
import proxyPassMiddleware from './lib/proxy-pass.middleware.js';
import { MiAPI } from './lib/pp.middleware.js';
import { urlReplacer } from './lib/helpers/url.helper.js';
import { type ClientService } from './lib/client.service.js';
import { initProxyCache } from './lib/proxy-cache.middleware.js';
import { DistService } from './lib/dist.service.js';
import { initRewriteResponse } from './lib/rewrite-response.middleware.js';
import { initPPRedirect } from './lib/pp-redirect.middleware.js';
import { initLoadPPData } from './lib/load-pp-data.middleware.js';
import { createInternalServer } from './lib/internal.middleware.js';
import { colors } from './lib/helpers/index.js';
import { RequestStore } from './lib/request-store.js';
import { createRequestCaptureMiddleware } from './lib/request-capture.middleware.js';
import { registerInspectorRoutes, INSPECTOR_PATH } from './lib/request-inspector.js';
import { VARIABLES_EDITOR_PATH } from './lib/variables-editor.js';
import { createUserHostGuard } from './lib/user-registry.js';
import { USERS_API_PATH } from './lib/user-routes.js';
import {
  getIndexPageRegExp,
  getMiAPIOptions,
  getProxyIgnore,
  resolveProxyCacheTtl,
  startSyncAndUsers,
} from './lib/dev-server-setup.js';
import type { NormalizedVitePPDevOptions } from './lib/pp-dev-config.js';

// Config types, validation and normalization live in a module without the server's dependencies.
export * from './lib/pp-dev-config.js';

// ─── Vite plugin ──────────────────────────────────────────────────────────────

function vitePPDev(options: NormalizedVitePPDevOptions): Plugin {
  const {
    templateName,
    templateLess,
    backendBaseURL,
    miHudLess,
    appId,
    enableProxyCache,
    proxyCacheTTL,
    disableSSLValidation,
    outDir,
    distZip,
    versionPlugin,
    syncBackupsDir,
    syncMaxBackups,
    syncBuildTimeoutMs,
    v7Features,
    personalAccessToken,
    inspectorEnabled,
    inspectorMaxMemory,
    inspectorCaptureLimit,
    devPanelPosition,
    devPanelHidden,
    devPanelAutoHide,
    persistUsers,
    allowedHosts,
  } = options || {};

  let isFirstRequest = true;
  // Per dev server, by its client environment: Vite's own restart (the `r` shortcut, a change of
  // `vite.config.*`) makes the new server with this same plugin instance, then closes the old one.
  // One variable held the new server's service by then, and the old server's closeBundle disposed it.
  const clientServices = new WeakMap<Environment, ClientService>();

  return {
    name: 'vite-pp-dev',
    apply: 'serve',
    // A `serve`-only plugin's closeBundle runs, once per environment, when the dev server closes (or
    // restarts, which makes a new one): the place to stop what the panel started, such as a sync's build.
    closeBundle() {
      clientServices.get(this.environment)?.dispose();
      clientServices.delete(this.environment);
    },
    config: (config) => {
      config.clientInjectionPlugin = {
        backendBaseURL,
        appId,
        templateLess,
        v7Features,
        devPanelPosition,
        devPanelHidden,
        devPanelAutoHide,
      };

      if (v7Features) {
        config.base = `/pl/${templateName}`;
      }

      return config;
    },
    transformIndexHtml: async (_html, _ctx) => {
      const result: IndexHtmlTransformResult = { html: _html, tags: [] };

      if (isFirstRequest) {
        isFirstRequest = false;
        result.tags.push({ tag: 'script', injectTo: 'body', children: `${Math.random()}` });
      }

      return result;
    },
    configureServer: (server) => {
      let base = server.config.base;

      if (!base.endsWith('/')) {
        base += '/';
      }

      if (backendBaseURL) {
        // Before Vite's own middlewares: a user host with no saved user behind it gets nothing.
        server.middlewares.use(createUserHostGuard());
      }

      server.middlewares.use(initPPRedirect(base, templateName));

      if (inspectorEnabled !== false) {
        const reqStore = new RequestStore(inspectorMaxMemory);

        server.middlewares.use(createRequestCaptureMiddleware(reqStore, inspectorCaptureLimit));

        const internalServer = createInternalServer({ allowedHosts });

        registerInspectorRoutes(internalServer, reqStore, inspectorCaptureLimit);

        // Only route internal pp-dev paths into the Express app. Mounting it for all
        // paths would run its global express.json()/urlencoded() body parsers, which
        // consume the request stream before the proxy can pipe it to the backend
        // (the backend then waits for a body that never arrives and replies 408).
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith('/@api/') || req.url?.startsWith(INSPECTOR_PATH)) {
            internalServer(req as never, res as never, next);

            return;
          }

          next();
        });
      }

      if (backendBaseURL) {
        server.config.logger.info(colors.blue(`🌐 Backend URL: ${backendBaseURL}`));
        server.config.logger.info(colors.blue(`🆔 Custom App ID: ${appId}`));

        const baseUrlHost = new URL(backendBaseURL).host;

        const miConfig = getMiAPIOptions(backendBaseURL, {
          appId,
          templateLess,
          disableSSLValidation,
          v7Features,
          personalAccessToken,
        });

        const mi = new MiAPI(backendBaseURL, miConfig);

        if (enableProxyCache) {
          server.middlewares.use(initProxyCache({ devServer: server, ttl: resolveProxyCacheTtl(proxyCacheTTL) }));
        }

        const isIndexRegExp = getIndexPageRegExp(base);

        server.middlewares.use(initLoadPPData(isIndexRegExp, mi, Object.assign({}, options, { appId, appBase: base })));

        server.middlewares.use(
          proxyPassMiddleware({
            devServer: server,
            baseURL: backendBaseURL,
            proxyIgnore: getProxyIgnore(base),
            disableSSLValidation,
            miAPI: mi,
            templateName,
          }),
        );

        const internalServer = createInternalServer({ allowedHosts });

        const distService = new DistService(
          templateName,
          Object.assign(
            {
              root: server.config.root,
              backupFolder: syncBackupsDir,
              maxBackups: syncMaxBackups,
              buildTimeoutMs: syncBuildTimeoutMs,
              buildInputFolder: typeof distZip === 'object' ? (distZip.inDir ?? outDir) : outDir,
            },
            typeof distZip === 'object'
              ? {
                  distZipFolder: distZip.outDir,
                  distZipFilename: distZip.outFileName,
                }
              : undefined,
            typeof versionPlugin === 'object'
              ? {
                  versionFileTemplate: versionPlugin.versionFileTemplate,
                }
              : undefined,
          ),
        );

        const clientService = startSyncAndUsers({
          server,
          internalServer,
          distService,
          miAPI: mi,
          persistUsers,
          projectRoot: server.config.root || process.cwd(),
          miUrl: backendBaseURL,
        });

        clientServices.set(server.environments.client, clientService);

        // IMPORTANT: mount `internalServer` only after all `.get`/`.post`/`.put`/... routes are
        // registered on it. Vite's own middleware-mounting (`server.middlewares.use`) sets a
        // `.route` string property on whatever's mounted (to track its mount path) — colliding
        // with and overwriting Express's own `app.route` *method*. Any route registered on this
        // app *after* it's been mounted crashes with "this.route is not a function".
        //
        // Only route internal pp-dev paths into the Express app (see the matching inspector
        // gate above) — mounting it for all paths would run its global express.json()/
        // urlencoded() body parsers, which consume the request stream before the proxy can
        // pipe it to the backend (the backend then waits for a body that never arrives and
        // replies 408).
        server.middlewares.use((req, res, next) => {
          if (
            req.url?.startsWith('/@api/login') ||
            req.url?.startsWith('/@api/variables/') ||
            req.url?.startsWith(USERS_API_PATH) ||
            req.url?.startsWith(VARIABLES_EDITOR_PATH)
          ) {
            internalServer(req as never, res as never, next);

            return;
          }

          next();
        });

        return () => {
          server.middlewares.use(
            initRewriteResponse(
              (url) => {
                return url.split('?')[0].endsWith('index.html');
              },
              (response, req) => {
                return Buffer.from(urlReplacer(baseUrlHost, req.headers.host ?? '', mi.buildPage(response, miHudLess)));
              },
            ),
          );
        };
      }
    },
  };
}

export default vitePPDev;
export { vitePPDev };
