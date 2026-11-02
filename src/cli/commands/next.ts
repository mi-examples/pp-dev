import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type createNextApp from 'next';
import type loadNextConfig from 'next/dist/server/config.js';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'node:events';
import { type ServerOptions } from 'vite';
import { type ViteDevServer } from 'vite';
import { parse } from 'url';
import { initRewriteResponse } from '../../lib/rewrite-response.middleware.js';
import { initPPRedirect } from '../../lib/pp-redirect.middleware.js';
import { MiAPI } from '../../lib/pp.middleware.js';
import { initProxyCache } from '../../lib/proxy-cache.middleware.js';
import proxyPassMiddleware from '../../lib/proxy-pass.middleware.js';
import { initLoadPPData } from '../../lib/load-pp-data.middleware.js';
import { createUserHostGuard } from '../../lib/user-registry.js';
import {
  getIndexPageRegExp,
  getMiAPIOptions,
  getProxyIgnore,
  resolveProxyCacheTtl,
  startSyncAndUsers,
} from '../../lib/dev-server-setup.js';
import { urlReplacer } from '../../lib/helpers/url.helper.js';
import { createLogger } from '../../lib/logger.js';
import { colors } from '../../lib/helpers/color.helper.js';
import { createInternalServer } from '../../lib/internal.middleware.js';
import { hostNotAllowedMessage, isHostAllowed, type AllowedHosts } from '../../lib/helpers/origin-guard.js';
import { safeNextImport } from '../../lib/next-import.js';
import { type ClientService } from '../../lib/client.service.js';
import { DistService } from '../../lib/dist.service.js';
import { PPDevHotServer, refuseUpgrade } from '../../lib/pp-ws-server.js';
import { registerProcessHandlers } from '../../lib/process-handlers.js';
import { NEXT_WORKER_SCHEDULER_REJECTION, createNextAppListenerTracker } from '../../lib/next-process-listeners.js';
import { injectDevPanel, createDevPanelAssetMiddleware } from '../../lib/dev-panel.js';
import {
  PATH_PAGE_PREFIX,
  PATH_TEMPLATE_PREFIX,
  PATH_TEMPLATE_LOCAL_PREFIX,
  PP_DEV_NEXT_BUILD_ENV_VAR,
} from '../../constants.js';
import { normalizePPDevConfig, validatePPDevConfig } from '../../lib/pp-dev-config.js';
import { RequestStore } from '../../lib/request-store.js';
import { createRequestCaptureMiddleware } from '../../lib/request-capture.middleware.js';
import { registerInspectorRoutes, INSPECTOR_PATH } from '../../lib/request-inspector.js';
import { VARIABLES_EDITOR_PATH } from '../../lib/variables-editor.js';
import { loadPPDevEnv } from '../../lib/env.js';
import { NEXT_IGNORED_FLAGS, resolveNextListenAddress } from '../../lib/cli-options.js';
import type { CAC } from 'cac';
import { createConfigWatcher, cleanupConfigWatcher, type ConfigWatcher } from '../config-watcher.js';
import {
  type NextCommandCLIOptions,
  type NextBundlerChoice,
  parseNextBundlerCli,
  isNextTurbopackNativeBindingsError,
  filterDuplicateOptions,
} from '../options.js';

export function registerNextCommand(cli: CAC): void {
  cli
    .command('next [root]', 'start Next.js development server with pp-dev integration')
    .alias('next-serve')
    .alias('next-dev')
    .option('--host [host]', `[string] specify hostname; without a value, listen on all addresses`)
    .option('--port <port>', `[number] specify port`, { default: 3000 })
    // Still accepted so existing scripts keep working, but `pp-dev next` has never acted on them.
    .option('--https', `[boolean] no effect with pp-dev next (deprecated)`)
    .option('--open [path]', `[boolean | string] no effect with pp-dev next (deprecated)`)
    .option('--cors', `[boolean] no effect with pp-dev next (deprecated)`)
    .option('--strictPort', `[boolean] no effect with pp-dev next (deprecated)`)
    .option('--force', `[boolean] no effect with pp-dev next (deprecated)`)
    .option('--webpack', `[boolean] use Webpack for Next dev (use when Turbopack/native SWC is unavailable)`)
    .option('--turbopack', `[boolean] use Turbopack for Next dev when native bindings work`)
    .action(async (root: string, options: ServerOptions & NextCommandCLIOptions) => {
      filterDuplicateOptions(options);

      const ignoredFlags = NEXT_IGNORED_FLAGS.filter((flag) => options[flag as keyof typeof options] !== undefined);

      if (ignoredFlags.length > 0) {
        createLogger(options.logLevel).warn(
          colors.yellow(
            `⚠️  ${ignoredFlags.map((flag) => `--${flag}`).join(', ')} ${ignoredFlags.length === 1 ? 'has' : 'have'} no effect with pp-dev next and will be removed.`,
          ),
        );
      }

      // `--host` alone (cac gives `true`) listens on all addresses, as with `pp-dev`; Next.js gets the
      // same value it is listened on.
      const { host: listenHost, port: listenPort } = resolveNextListenAddress(options.host, options.port);

      let nextApp: ReturnType<typeof createNextApp> | null = null;
      let httpServer: any = null;
      let hotServer: PPDevHotServer | null = null;
      /** The dev panel service on {@link hotServer}; disposed before it closes, to stop a sync's build. */
      let clientService: ClientService | null = null;
      let configWatcher: ConfigWatcher | null = null;
      let isRestarting = false;

      // Connections to the current HTTP server, so a restart or shutdown can end them.
      const openSockets = new Set<Socket>();

      const logger = createLogger(options.logLevel);

      // Next.js adds process listeners per app and leaves them attached after close().
      const nextAppListeners = createNextAppListenerTracker();

      const closeNextApp = async () => {
        if (nextApp && typeof nextApp.close === 'function') {
          await nextApp.close();
        }

        nextApp = null;
      };

      // Keep-alive connections would hold `close()` open, so they are ended first.
      const closeHttpServer = async () => {
        const server = httpServer;

        if (!server) {
          return;
        }

        for (const socket of openSockets) {
          socket.destroy();
        }

        openSockets.clear();

        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });

        if (httpServer === server) {
          httpServer = null;
        }
      };

      const startNextServer = async () => {
        if (isRestarting) {
          return;
        }

        isRestarting = true;

        try {
          // Import Next.js first – with logger available for error reporting
          const { next, constants } = await safeNextImport();
          const { PHASE_DEVELOPMENT_SERVER } = constants;

          // Clean up existing dev-panel WebSocket server if any
          clientService?.dispose();
          clientService = null;

          if (hotServer) {
            await hotServer.close();
            hotServer = null;
          }

          // Clean up existing server if any
          if (httpServer) {
            logger.info(colors.yellow('🛑 Stopping existing Next.js server...'));
            await closeHttpServer();
          }

          // Clean up existing Next.js app if any
          await closeNextApp();

          // Clear config cache
          const { clearConfigCache } = await import('../../config.js');

          clearConfigCache();

          const { join } = await import('path');
          const { createServer } = await import('http');

          const importConfig = await import('next/dist/server/config.js');

          const loadConfig: typeof loadNextConfig =
            (importConfig as any).default.default ||
            (importConfig as any)['module.exports'].default ||
            (importConfig as any).default;

          const projectRoot = root ? join(process.cwd(), root) : process.cwd();

          loadPPDevEnv(options.mode || 'development', projectRoot);

          // Get pp-dev config from Next.js app config
          const config = await loadConfig(PHASE_DEVELOPMENT_SERVER, projectRoot);

          // Extract pp-dev configuration from Next.js config
          let ppDevConfig = config?.ppDev || {};

          // If no pp-dev config found in Next.js config, try to load from standalone config file
          if (Object.keys(ppDevConfig).length === 0) {
            try {
              const { getConfig } = await import('../../config.js');
              const standaloneConfig = await getConfig(projectRoot);

              if (Object.keys(standaloneConfig).length > 0) {
                ppDevConfig = standaloneConfig;
                logger.info(colors.blue(`🔧 Loaded pp-dev config from standalone config file`));
              } else {
                logger.info(
                  colors.yellow('⚠️  No pp-dev config found in Next.js config or standalone file, using defaults'),
                );
              }
            } catch (error) {
              logger.warn(
                colors.yellow(
                  `⚠️  Failed to load standalone pp-dev config, using defaults: ${error instanceof Error ? error.message : String(error)}`,
                ),
              );
            }
          } else {
            logger.info(colors.blue(`🔧 Loaded pp-dev config from Next.js config`));
          }

          const { getPkg } = await import('../../config.js');
          const packageName = getPkg(projectRoot).name;

          // Normalize grouped PPDevConfig to internal flat options
          validatePPDevConfig(ppDevConfig, packageName);

          const _normalized = normalizePPDevConfig(ppDevConfig, packageName);
          // `app.name`, else package.json's `name`: the one name for the base path, redirects and sync.
          const { templateName } = _normalized;
          // No `mi.url` (a standalone page without a backend): no MI middleware, as under `pp-dev`. A
          // made-up `http://localhost:8080` used to switch it on, needing an app.id the page doesn't have.
          const backendBaseURL = _normalized.backendBaseURL;
          const templateLess = _normalized.templateLess;
          const v7Features = _normalized.v7Features;
          const disableSSLValidation = _normalized.disableSSLValidation;
          const enableProxyCache = _normalized.enableProxyCache;
          const proxyCacheTTL = _normalized.proxyCacheTTL;
          const personalAccessToken = _normalized.personalAccessToken;
          const miHudLess = _normalized.miHudLess;
          const inspectorEnabled = _normalized.inspectorEnabled;
          const inspectorMaxMemory = _normalized.inspectorMaxMemory;
          const inspectorCaptureLimit = _normalized.inspectorCaptureLimit;

          // From the config only, as under `pp-dev`. Validation already requires `app.id` wherever
          // page data is loaded; the undocumented MI_APP_ID / MI_PORTAL_PAGE_ID and a silent `1`
          // could point the dev server at the wrong page.
          const appId = _normalized.appId;

          // The hosts this server answers, as Vite's own check does under `pp-dev`: IP addresses,
          // localhost, `server.allowedHosts` and the `--host` name (see isHostAllowed).
          const allowedHosts: AllowedHosts =
            _normalized.allowedHosts === true ? true : [..._normalized.allowedHosts, listenHost.toLowerCase()];
          // pp-dev's own routes, made again on each (re)start with that start's services.
          const internalServer = createInternalServer({ allowedHosts: _normalized.allowedHosts });

          const configBasePath = config?.basePath;
          let base = '';

          if (configBasePath) {
            base = configBasePath;
          } else {
            base = templateLess ? PATH_PAGE_PREFIX : v7Features ? PATH_TEMPLATE_LOCAL_PREFIX : PATH_TEMPLATE_PREFIX;
            base += `/${templateName}`;
          }

          const bundlerChoice = parseNextBundlerCli(options);

          const createAndPrepareNext = async (bundler: NextBundlerChoice) => {
            // Next's createServer() mutates process.env.TURBOPACK. Clear it before each
            // attempt so a failed "auto" run does not leave TURBOPACK=auto and block Webpack.
            delete process.env.TURBOPACK;

            await closeNextApp();

            const nextOptions: Parameters<typeof next>[0] = {
              dev: true,
              customServer: true,
              hostname: listenHost,
              port: listenPort,
              dir: projectRoot,
              conf: {
                ...config,
                basePath: base,
                assetPrefix: base,
              },
            };

            if (bundler.webpack) {
              nextOptions.webpack = true;
            } else if (bundler.turbopack) {
              nextOptions.turbopack = true;
            }

            nextAppListeners.beforeCreate();
            nextApp = next(nextOptions);
            await nextApp.prepare();
            nextAppListeners.afterCreate();
          };

          if (bundlerChoice.webpack) {
            await createAndPrepareNext({ webpack: true });
          } else if (bundlerChoice.turbopack) {
            try {
              await createAndPrepareNext({ turbopack: true });
            } catch (e) {
              if (!isNextTurbopackNativeBindingsError(e)) {
                throw e;
              }

              logger.warn(colors.yellow('⚠ Turbopack is unavailable (native bindings). Falling back to Webpack.'));
              await createAndPrepareNext({ webpack: true });
            }
          } else {
            try {
              await createAndPrepareNext({});
            } catch (e) {
              if (!isNextTurbopackNativeBindingsError(e)) {
                throw e;
              }

              logger.warn(
                colors.yellow('⚠ Turbopack cannot run (native Next.js bindings unavailable). Falling back to Webpack.'),
              );
              await createAndPrepareNext({ webpack: true });
            }
          }

          if (!nextApp) {
            throw new Error('Next.js app failed to initialize');
          }

          if (!base.endsWith('/')) {
            base += '/';
          }

          if (base === '/') {
            throw new Error('basePath cannot be equal to "/" or equal to empty string');
          }

          // Log the configuration
          logger.info(colors.green('✅ Next.js app prepared successfully'));
          logger.info(colors.blue(`🔧 pp-dev plugin configured for template: ${templateName}`));
          logger.info(colors.blue(`🔧 Base path configured: ${base}`));

          if (backendBaseURL) {
            logger.info(colors.blue(`🌐 Backend URL: ${backendBaseURL}`));
            logger.info(colors.blue(`🆔 Custom App ID: ${appId}`));
          }

          // Get the Next.js request handler
          const handle = nextApp.getRequestHandler();

          // Start the server
          const port = listenPort;
          const host = listenHost;

          // Create HTTP server with base path handling and pp-dev middlewares
          httpServer = createServer(async (req: any, res: any) => {
            // Before anything else: a name pointed at 127.0.0.1 by another site (DNS rebinding).
            const requestHost = (req as IncomingMessage).headers.host;

            if (!isHostAllowed(requestHost, allowedHosts)) {
              (res as ServerResponse).writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
              (res as ServerResponse).end(hostNotAllowedMessage(requestHost));

              return;
            }

            try {
              const originalUrl = req.url || '/';
              const originalPathname = originalUrl.split('?')[0];

              let parsedUrl = parse(originalUrl, true);

              // Apply pp-dev middleware chain if available
              if (fullMiddlewareChain.length > 0) {
                // Check if this is an internal Next.js route that should skip most middlewares.
                // `/favicon.ico` is not: the browser asks for it at the root, where Next serves no
                // icon (only under the base path), so it goes to MI through the proxy, as under `pp-dev`.
                const isInternalNextRoute =
                  originalPathname.startsWith('/_next/') || originalPathname.startsWith('/__nextjs_');

                if (isInternalNextRoute) {
                  // For internal routes, only apply essential middlewares (skip proxy, cache, etc.)

                  if (essentialMiddlewareChain.length > 0) {
                    let middlewareIndex = 0;

                    const runEssentialMiddleware = () => {
                      if (middlewareIndex >= essentialMiddlewareChain.length) {
                        // Essential middlewares processed, continue with Next.js handling
                        processNextJSRequest();

                        return;
                      }

                      const middleware = essentialMiddlewareChain[middlewareIndex];

                      middlewareIndex++;

                      middleware(req, res, runEssentialMiddleware);
                    };

                    runEssentialMiddleware();

                    return; // Exit early, middleware will handle the rest
                  } else {
                    // No essential middlewares, process normally
                    processNextJSRequest();

                    return;
                  }
                }

                // For non-internal routes, apply full middleware chain
                let middlewareIndex = 0;

                const runMiddleware = () => {
                  if (middlewareIndex >= fullMiddlewareChain.length) {
                    // All middlewares processed, continue with Next.js handling
                    processNextJSRequest();

                    return;
                  }

                  const middleware = fullMiddlewareChain[middlewareIndex];

                  middlewareIndex++;

                  middleware(req, res, runMiddleware);
                };

                runMiddleware();

                return; // Exit early, middleware will handle the rest
              }

              // If no middlewares, process normally
              processNextJSRequest();

              async function processNextJSRequest() {
                // Handle base path requests - pass full path to Next.js so it can apply basePath routing
                if (originalPathname.startsWith(base)) {
                  // Keep full path - Next.js expects req.url to include basePath for proper routing
                  parsedUrl = parse(originalUrl, true);
                } else if (originalPathname === base.replace(/\/$/, '')) {
                  // Path without trailing slash - redirect to canonical URL with trailing slash
                  const redirectUrl = originalUrl.replace(originalPathname, base);

                  res.writeHead(302, { Location: redirectUrl });
                  res.end();

                  return;
                } else if (originalPathname.startsWith('/_next/') || originalPathname.startsWith('/__nextjs_')) {
                  // Next.js internal routes - pass through as-is
                } else if (originalPathname === '/') {
                  // Root path - this should redirect to base path
                  res.writeHead(302, { Location: base });
                  res.end();

                  return;
                } else {
                  // Other requests - pass through as-is
                }

                await handle(req, res, parsedUrl);
              }
            } catch (error) {
              logger.error(`Error handling request: ${error instanceof Error ? error.message : String(error)}`, {
                error: error instanceof Error ? error : undefined,
              });
              res.statusCode = 500;
              res.end('Internal Server Error');
            }
          });

          /** Where an allowed upgrade goes; set with a backend (the dev-panel WebSocket, then Next's HMR). */
          let forwardUpgrade: ((req: IncomingMessage, socket: Socket, head: Buffer) => void) | null = null;

          // Every upgrade, with or without a backend: the Host check first. On its first request Next
          // adds an upgrade listener of its own to this server (setupWebSocketHandler), after this one;
          // without a backend that listener takes every upgrade this check lets through. It also sees
          // the refused ones, on a socket that already has its 403, and refuses another site's Origin
          // itself (allowedDevOrigins).
          const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
            if (!isHostAllowed(req.headers.host, allowedHosts)) {
              refuseUpgrade(socket);

              return;
            }

            if (forwardUpgrade) {
              forwardUpgrade(req, socket, head);
            } else if ((httpServer as Server).listeners('upgrade').every((listener) => listener === onUpgrade)) {
              // Nothing else can take it yet: before Next's first request (an open tab's HMR
              // reconnecting after a restart), the socket would hang. Closed, the client retries.
              socket.destroy();
            }
          };

          httpServer.on('upgrade', onUpgrade);

          // Initialize pp-dev middlewares
          let mi: MiAPI | null = null;
          /** All pp-dev middlewares for non-internal routes (app pages). Includes redirect, proxy cache, proxy pass, load PP data, internal server, rewrite response. */
          const fullMiddlewareChain: Array<(req: any, res: any, next: () => void) => void> = [];
          /** Essential middlewares for internal Next.js routes (e.g. /_next/). Only redirect and internal server; skips proxy/cache for faster static asset handling. */
          const essentialMiddlewareChain: Array<(req: any, res: any, next: () => void) => void> = [];

          // Request inspector: register routes on internalServer and add capture middleware
          if (inspectorEnabled !== false) {
            const reqStore = new RequestStore(inspectorMaxMemory);

            registerInspectorRoutes(internalServer, reqStore, inspectorCaptureLimit);

            const captureMiddleware = createRequestCaptureMiddleware(reqStore, inspectorCaptureLimit);

            fullMiddlewareChain.push(captureMiddleware);
          }

          /** Serves pp-dev's own routes (API, inspector and editor UI) from `internalServer`. */
          const internalServerWrapper = (req: any, res: any, next: () => void) => {
            // Check if this is an internal pp-dev request (API or inspector/editor UI)
            if (
              req.url?.startsWith('/@api/') ||
              req.url?.startsWith(INSPECTOR_PATH) ||
              req.url?.startsWith(VARIABLES_EDITOR_PATH)
            ) {
              const mockNext = () => {};

              internalServer(req, res, mockNext);

              return; // Don't call next() for internal pp-dev requests
            }

            next();
          };

          // Without a backend there is no MI middleware, but the Request Inspector still works, as under
          // `pp-dev`: its routes are served on their own.
          if (!backendBaseURL && inspectorEnabled !== false) {
            essentialMiddlewareChain.push(internalServerWrapper);
            fullMiddlewareChain.push(internalServerWrapper);
          }

          if (backendBaseURL) {
            const baseUrlHost = new URL(backendBaseURL).host;

            // 0. A user host with no saved user behind it gets nothing, not even Next.js assets.
            const userHostGuard = createUserHostGuard();

            essentialMiddlewareChain.unshift(userHostGuard);
            fullMiddlewareChain.unshift(userHostGuard);

            if (backendBaseURL.startsWith('https://')) {
              EventEmitter.defaultMaxListeners = Math.max(EventEmitter.defaultMaxListeners, 20);
            }

            // Initialize MiAPI
            const miConfig = getMiAPIOptions(backendBaseURL, {
              appId,
              templateLess,
              disableSSLValidation,
              v7Features,
              personalAccessToken,
            });

            mi = new MiAPI(backendBaseURL, miConfig);

            // Create middleware chain for HTTP server
            // Note: We need to adapt Express middlewares to work with raw HTTP requests

            // 1. PP Redirect middleware (essential for all routes)
            const ppRedirectMiddleware = initPPRedirect(base, templateName);
            const ppRedirectWrapper = (req: any, res: any, next: () => void) => {
              ppRedirectMiddleware(req, res, next);
            };

            essentialMiddlewareChain.push(ppRedirectWrapper);
            fullMiddlewareChain.push(ppRedirectWrapper);

            // 1b. Dev-panel client assets (client.js/client.css) — served locally, never proxied.
            const devPanelAssetMiddleware = createDevPanelAssetMiddleware(base);

            essentialMiddlewareChain.push(devPanelAssetMiddleware);
            fullMiddlewareChain.push(devPanelAssetMiddleware);

            // 2. Proxy Cache middleware (only for non-internal routes)
            if (enableProxyCache) {
              const ttl = resolveProxyCacheTtl(proxyCacheTTL);

              // Create mock devServer object that satisfies the type requirements
              const mockDevServer = {
                middlewares: {
                  use: (fn: any) => fn,
                },
                config: { logger: console },
              } as any;

              const cacheConfig = {
                devServer: mockDevServer,
                ttl,
              };

              const proxyCacheMiddleware = initProxyCache(cacheConfig);
              const proxyCacheWrapper = (req: any, res: any, next: () => void) => {
                proxyCacheMiddleware(req, res, next);
              };

              fullMiddlewareChain.push(proxyCacheWrapper);

              logger.info(colors.blue(`🔧 Proxy cache middleware added with TTL: ${ttl}ms`));
            }

            // 3. Load PP Data middleware (only for non-internal routes; before proxy so v7 internal page name is available for `/data/page/` rewrites)
            const isIndexRegExp = getIndexPageRegExp(base);
            const loadPPDataMiddleware = initLoadPPData(
              isIndexRegExp,
              mi,
              Object.assign({ base }, miConfig, { miHudLess }),
            );
            const loadPPDataWrapper = (req: any, res: any, next: () => void) => {
              loadPPDataMiddleware(req, res, next);
            };

            fullMiddlewareChain.push(loadPPDataWrapper);

            // 4. Proxy Pass middleware (only for non-internal routes)

            // Create mock devServer object for proxy pass middleware
            const mockProxyDevServer = {
              middlewares: {
                use: (fn: any) => fn,
              },
              config: { logger: console },
            } as any;

            const proxyPassMiddlewareInstance = proxyPassMiddleware({
              devServer: mockProxyDevServer,
              baseURL: backendBaseURL,
              proxyIgnore: [
                ...getProxyIgnore(base),
                // Next.js internal routes that should not be proxied
                '/_next',
                '/__nextjs_',
                '/installHook.js.map',
              ],
              disableSSLValidation,
              miAPI: mi,
              templateName,
            });

            const proxyPassWrapper = (req: any, res: any, next: () => void) => {
              proxyPassMiddlewareInstance(req, res, next);
            };

            fullMiddlewareChain.push(proxyPassWrapper);

            // 5. Internal Server middleware (API endpoints + inspector UI) - essential for all routes
            essentialMiddlewareChain.push(internalServerWrapper);
            fullMiddlewareChain.push(internalServerWrapper);

            // 6. Rewrite Response middleware (only for non-internal routes)
            const rewriteResponseMiddleware = initRewriteResponse(
              (url) => {
                const pathname = url.split('?')[0];

                // Next.js serves page HTML at base path or subpaths (e.g. /p/test-nextjs/, /p/test-nextjs/dashboard),
                // not at index.html. Match page requests under base, excluding /_next/ static assets.
                return pathname.startsWith(base) && !pathname.includes('/_next/');
              },
              (response, req, res) => {
                // Pages only: the check above goes by path, and the app's own files under the base
                // path (its icon, public/ images and JSON) were read as text, a binary one corrupted.
                if (!String(res.getHeader('content-type') ?? '').includes('text/html')) {
                  return response;
                }

                const page = mi!.buildPage(response, miHudLess);
                // Inject the dev panel before host-rewriting so its `!!`-prefixed backend
                // links are handled by urlReplacer like the rest of the page.
                const withPanel = injectDevPanel(page, base, {
                  backendBaseURL,
                  templateLess,
                  appId,
                  devPanelPosition: _normalized.devPanelPosition,
                  devPanelHidden: _normalized.devPanelHidden,
                  devPanelAutoHide: _normalized.devPanelAutoHide,
                });

                return Buffer.from(urlReplacer(baseUrlHost, req.headers.host ?? '', withPanel));
              },
            );

            const rewriteResponseWrapper = (req: any, res: any, next: () => void) => {
              rewriteResponseMiddleware(req, res, next);
            };

            fullMiddlewareChain.push(rewriteResponseWrapper);

            // Dev-panel transport: raw-WebSocket replacement for Vite HMR so the panel's
            // interactive features (template sync) work under Next.js. ClientService is
            // reused unchanged via a Vite-WS-compatible facade.
            hotServer = new PPDevHotServer({ allowedHosts: _normalized.allowedHosts });

            // The sync `next build` runs in production mode, which writes the static export
            // to the base distDir. Next's dev phase reports distDir as `<distDir>/dev`, so
            // resolve it from the production config and defensively strip a trailing `/dev`.
            // With output:'export', the export lands in distDir (or `out` for the default).
            let exportDistDir: string | undefined = config?.distDir;

            // Not a real `next build` — just peeking at the prod config for distDir. Suppress
            // withPPDev()'s "use pp-dev next-build" nudge for this internal lookup only.
            const previousNextBuildFlag = process.env[PP_DEV_NEXT_BUILD_ENV_VAR];

            process.env[PP_DEV_NEXT_BUILD_ENV_VAR] = '1';

            try {
              const prodConfig = await loadConfig(constants.PHASE_PRODUCTION_BUILD, projectRoot);

              exportDistDir = prodConfig?.distDir ?? exportDistDir;
            } catch {
              // Fall back to the dev config's distDir (normalized below).
            } finally {
              if (previousNextBuildFlag === undefined) {
                delete process.env[PP_DEV_NEXT_BUILD_ENV_VAR];
              } else {
                process.env[PP_DEV_NEXT_BUILD_ENV_VAR] = previousNextBuildFlag;
              }
            }

            const normalizedDistDir = (exportDistDir ?? '')
              .replace(/\\/g, '/')
              .replace(/\/+$/, '')
              .replace(/\/dev$/, '');
            const nextExportDir = !normalizedDistDir || normalizedDistDir === '.next' ? 'out' : normalizedDistDir;

            let nextPackageVersion = '0.0.0';
            let nextPackageRepositoryUrl: string | undefined;

            try {
              const projectPkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));

              nextPackageVersion = typeof projectPkg.version === 'string' ? projectPkg.version : nextPackageVersion;
              nextPackageRepositoryUrl =
                typeof projectPkg.repository === 'string' ? projectPkg.repository : projectPkg.repository?.url;
            } catch {
              // Fall back to defaults if the project package.json is unreadable.
            }

            const distService = new DistService(templateName, {
              root: projectRoot,
              backupFolder: path.resolve(projectRoot, _normalized.syncBackupsDir),
              maxBackups: _normalized.syncMaxBackups,
              buildTimeoutMs: _normalized.syncBuildTimeoutMs,
              nextBuild: {
                projectRoot,
                distDir: nextExportDir,
                packageVersion: nextPackageVersion,
                packageRepositoryUrl: nextPackageRepositoryUrl,
              },
            });

            // Minimal ViteDevServer shape consumed by ClientService (`ws` + the v7 flag).
            const clientServiceServer = {
              ws: hotServer.ws,
              config: { clientInjectionPlugin: { v7Features } },
            } as unknown as ViteDevServer;

            clientService = startSyncAndUsers({
              server: clientServiceServer,
              internalServer,
              distService,
              miAPI: mi,
              persistUsers: _normalized.persistUsers,
              projectRoot,
              miUrl: backendBaseURL,
            });

            // Route HTTP upgrades: pp-dev WS to our server, everything else (Next.js HMR)
            // to Next's own upgrade handler when available.
            const nextUpgradeHandler =
              typeof (nextApp as any)?.getUpgradeHandler === 'function' ? (nextApp as any).getUpgradeHandler() : null;

            forwardUpgrade = (req, socket, head) => {
              if (hotServer?.handleUpgrade(req, socket, head)) {
                return;
              }

              if (nextUpgradeHandler) {
                nextUpgradeHandler(req, socket, head);
              } else {
                socket.destroy();
              }
            };

            logger.info(colors.blue(`🔧 ${fullMiddlewareChain.length} pp-dev middlewares initialized`));
            logger.info(colors.blue(`🔧 ${essentialMiddlewareChain.length} essential middlewares for internal routes`));
            logger.info(colors.blue(`🔧 MiAPI initialized for backend: ${backendBaseURL}`));
            logger.info(colors.blue(`🔧 Custom App ID: ${appId}`));
          }

          httpServer.listen(port, host, () => {
            logger.info(colors.green(`✅ pp-dev Next.js server running at http://${host}:${port}`));
            logger.info(colors.blue(`📱 Next.js app accessible at http://${host}:${port}${base}`));

            if (inspectorEnabled !== false) {
              logger.info(colors.cyan(`🔍 Request Inspector: http://${host}:${port}${INSPECTOR_PATH}`));
            }

            logger.info(colors.blue(`🔧 Base path handling active`));

            // Set up config watcher
            if (!configWatcher) {
              configWatcher = createConfigWatcher(projectRoot, startNextServer, logger.info);
              logger.info(colors.blue('🔧 Config file watcher started'));
            }

            // Track open sockets for proper cleanup
            httpServer.on('connection', (socket: any) => {
              openSockets.add(socket);
              socket.on('close', () => openSockets.delete(socket));
            });
          });

          isRestarting = false;
        } catch (error: any) {
          isRestarting = false;
          logger.error(colors.red(`❌ Failed to start Next.js server: ${error?.message}. Stack: ${error?.stack}`));

          // Special handling for Next.js peer dependency errors
          if (error instanceof Error && error.message.includes('Next.js is required')) {
            logger.error(colors.red('❌ Next.js Peer Dependency Error:'));
            logger.error(colors.red(error.message));
            logger.error(colors.yellow('\n💡 To fix this issue:'));
            logger.error(colors.blue('   1. Install Next.js in your project:'));
            logger.error(colors.white('      npm install next@^16'));
            logger.error(colors.blue('   2. Or use yarn:'));
            logger.error(colors.white('      yarn add next@^16'));
            logger.error(colors.blue('   3. Or use pnpm:'));
            logger.error(colors.white('      pnpm add next@^16'));
            logger.error(colors.yellow('\n📖 For more information, see:'));
            logger.error(colors.blue('   https://nextjs.org/docs/getting-started'));
          }

          process.exit(1);
        }
      };

      registerProcessHandlers({
        logger,
        knownRejections: [NEXT_WORKER_SCHEDULER_REJECTION],
        shutdown: async () => {
          if (configWatcher) {
            cleanupConfigWatcher(configWatcher);
            configWatcher = null;
          }

          clientService?.dispose();
          clientService = null;

          if (hotServer) {
            await hotServer.close();
            hotServer = null;
          }

          await closeHttpServer();
          await closeNextApp();
        },
      });

      // Start the server
      await startNextServer();
    });
}
