import type { Connect, Environment, IndexHtmlTransformResult, Plugin } from 'vite';
import { urlReplacer } from './lib/helpers/url.helper.js';
import { type ClientService } from './lib/client.service.js';
import { DistService } from './lib/dist.service.js';
import { createInternalServer } from './lib/internal.middleware.js';
import { colors } from './lib/helpers/index.js';
import { startSyncAndUsers } from './lib/dev-server-setup.js';
import { createMiddlewareChain, mountMiddlewareChain } from './lib/middleware-chain.js';
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

      // pp-dev's own routes: the inspector's now, the sync, login, editor and users routes below.
      const internalServer = createInternalServer({ allowedHosts });

      // Before Vite's own middlewares, in the order `pp-dev next` runs them too (middleware-chain.ts).
      const chain = createMiddlewareChain({
        base,
        templateName,
        internalServer,
        backendBaseURL,
        mi: { appId, templateLess, miHudLess, disableSSLValidation, v7Features, personalAccessToken },
        inspector: {
          enabled: inspectorEnabled !== false,
          maxMemory: inspectorMaxMemory,
          captureLimit: inspectorCaptureLimit,
        },
        proxy: { cache: enableProxyCache, cacheTtl: proxyCacheTTL, devServer: server },
        rewrite: (mi, baseUrlHost) => ({
          predicate: (url) => url.split('?')[0].endsWith('index.html'),
          transform: (response, req) =>
            Buffer.from(urlReplacer(baseUrlHost, req.headers.host ?? '', mi.buildPage(response, miHudLess))),
        }),
      });

      mountMiddlewareChain(server, chain);

      if (backendBaseURL && chain.mi) {
        const mi = chain.mi;

        server.config.logger.info(colors.blue(`🌐 Backend URL: ${backendBaseURL}`));
        server.config.logger.info(colors.blue(`🆔 Custom App ID: ${appId}`));

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
      }

      const { rewrite } = chain;

      if (rewrite) {
        // A post hook: Vite installs it after its own middlewares and right before the one that
        // serves index.html, whose response it rewrites.
        return () => {
          server.middlewares.use(rewrite as unknown as Connect.NextHandleFunction);
        };
      }
    },
  };
}

export default vitePPDev;
export { vitePPDev };
