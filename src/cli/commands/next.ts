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
import { createMiddlewareChain } from '../../lib/middleware-chain.js';
import { type ChainMiddleware, runMiddlewareChain, startSyncAndUsers } from '../../lib/dev-server-setup.js';
import { urlReplacer } from '../../lib/helpers/url.helper.js';
import { createLogger } from '../../lib/logger.js';
import { colors } from '../../lib/helpers/color.helper.js';
import { createInternalServer } from '../../lib/internal.middleware.js';
import { hostNotAllowedMessage, isHostAllowed, type AllowedHosts } from '../../lib/helpers/origin-guard.js';
import { safeNextImport } from '../../lib/next-import.js';
import { clearWithPPDevHandoff, readWithPPDevHandoff } from '../../lib/next-config-handoff.js';
import { type ClientService } from '../../lib/client.service.js';
import { DistService } from '../../lib/dist.service.js';
import { PPDevHotServer, refuseUpgrade } from '../../lib/pp-ws-server.js';
import { registerProcessHandlers } from '../../lib/process-handlers.js';
import { NEXT_WORKER_SCHEDULER_REJECTION, createNextAppListenerTracker } from '../../lib/next-process-listeners.js';
import { injectDevPanel } from '../../lib/dev-panel.js';
import {
  PATH_PAGE_PREFIX,
  PATH_TEMPLATE_PREFIX,
  PATH_TEMPLATE_LOCAL_PREFIX,
  PP_DEV_PROJECT_ROOT_ENV_VAR,
} from '../../constants.js';
import { configuredNextDistDir } from '../../lib/next-build-runner.js';
import { normalizePPDevConfig, validatePPDevConfig } from '../../lib/pp-dev-config.js';
import { INSPECTOR_PATH } from '../../lib/request-inspector.js';
import { loadPPDevEnv } from '../../lib/env.js';
import { NEXT_IGNORED_FLAGS, resolveNextListenAddress } from '../../lib/cli-options.js';
import type { CAC } from 'cac';
import { isNextServerProcess, reportNextServerReady, superviseNextServer } from '../next-supervisor.js';
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

      // The process the user started supervises: it watches the config files and runs the server in
      // a process of its own, started again on a change (see next-supervisor.ts for why). Everything
      // below is the server process.
      if (!isNextServerProcess()) {
        await superviseNextServer({
          projectRoot: root ? path.resolve(process.cwd(), root) : process.cwd(),
          logger: createLogger(options.logLevel),
          mode: options.mode || 'development',
        });

        return;
      }

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
      let listenHost: string;
      let listenPort: number;

      try {
        ({ host: listenHost, port: listenPort } = resolveNextListenAddress(options.host, options.port));
      } catch (error) {
        createLogger(options.logLevel).error(colors.red(`❌ ${(error as Error).message}`));
        process.exit(1);
      }

      let nextApp: ReturnType<typeof createNextApp> | null = null;
      let httpServer: any = null;
      let hotServer: PPDevHotServer | null = null;
      /** The dev panel service on {@link hotServer}; disposed before it closes, to stop a sync's build. */
      let clientService: ClientService | null = null;

      // Connections to the HTTP server, so the shutdown can end them.
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
        try {
          // Import Next.js first – with logger available for error reporting
          const { next, constants } = await safeNextImport();
          const { PHASE_DEVELOPMENT_SERVER } = constants;

          const { createServer } = await import('http');

          const importConfig = await import('next/dist/server/config.js');

          const loadConfig: typeof loadNextConfig =
            (importConfig as any).default.default ||
            (importConfig as any)['module.exports'].default ||
            (importConfig as any).default;

          // As `next dev` sets it, whatever it was (a test runner's `test`): Next's own code in this
          // process goes by it, not only the bundles' define. Under another value the tsconfig include
          // Next writes for the route types was the build's (`<distDir>/dev/types`, i.e.
          // `dist/dev/dev/types`), added to the app's tsconfig on every start.
          Object.assign(process.env, { NODE_ENV: 'development' });

          // As `serve` and `next-build` resolve it: `join` took an absolute root for a relative one.
          const projectRoot = root ? path.resolve(process.cwd(), root) : process.cwd();

          loadPPDevEnv(options.mode || 'development', projectRoot);
          process.env[PP_DEV_PROJECT_ROOT_ENV_VAR] = projectRoot;

          // Get pp-dev config from Next.js app config. `withPPDev()` also hands its result over out
          // of band: Next 13 and 14 drop the non-enumerable `ppDev` and `ppDevWrapped` from the config.
          clearWithPPDevHandoff();

          const config = await loadConfig(PHASE_DEVELOPMENT_SERVER, projectRoot);
          const handoff = readWithPPDevHandoff();

          // Extract pp-dev configuration from Next.js config
          let ppDevConfig = config?.ppDev || handoff?.ppDev || {};

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
          // The app's distDir as configured: the loaded config's is the dev phase's `<distDir>/dev`,
          // to which Next appends `/dev` again when handed as `conf` (see configuredNextDistDir).
          const nextDistDir = configuredNextDistDir(config);

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
                distDir: nextDistDir,
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

                // Internal routes get the essential middlewares only (no proxy, cache, …). A
                // middleware's `next(error)` ends the request with a 500, as under Vite, instead of
                // going on to Next.js without the page's data.
                runMiddlewareChain(
                  isInternalNextRoute ? essentialMiddlewareChain : fullMiddlewareChain,
                  req,
                  res,
                  () => void processNextJSRequest(),
                );

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

          // pp-dev's middlewares: the chain `pp-dev` builds too (middleware-chain.ts), run here on the
          // raw http server before Next.js.
          if (backendBaseURL?.startsWith('https://')) {
            EventEmitter.defaultMaxListeners = Math.max(EventEmitter.defaultMaxListeners, 20);
          }

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
            // Next.js's own routes are never proxied.
            proxy: {
              cache: enableProxyCache,
              cacheTtl: proxyCacheTTL,
              ignore: ['/_next', '/__nextjs_', '/installHook.js.map'],
            },
            // The dev panel's client.js / client.css, served locally.
            devPanelAssets: true,
            rewrite: (mi, baseUrlHost) => ({
              // Next.js serves page HTML at the base path or below it (/p/test-nextjs/,
              // /p/test-nextjs/dashboard), not at index.html; /_next/ assets are left out.
              predicate: (url) => {
                const pathname = url.split('?')[0];

                return pathname.startsWith(base) && !pathname.includes('/_next/');
              },
              transform: (response, req) => {
                const page = mi.buildPage(response, miHudLess);
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
              // Pages only: the check above goes by path, and the app's own files under the base
              // path (its icon, public/ images and JSON) were read as text, a binary one corrupted,
              // and a route handler's stream was held back until it ended.
              contentType: (contentType) => contentType.includes('text/html'),
            }),
          });

          /** All pp-dev middlewares for a page request, the rewrite last. */
          const fullMiddlewareChain: ChainMiddleware[] = chain.rewrite ? [...chain.main, chain.rewrite] : chain.main;
          /** For Next.js's own routes (/_next/): no proxy, no page data. */
          const essentialMiddlewareChain: ChainMiddleware[] = chain.essential;

          if (chain.proxyCacheTtl !== null) {
            logger.info(colors.blue(`🔧 Proxy cache middleware added with TTL: ${chain.proxyCacheTtl}ms`));
          }

          if (backendBaseURL && chain.mi) {
            const mi = chain.mi;

            // Dev-panel transport: raw-WebSocket replacement for Vite HMR so the panel's
            // interactive features (template sync) work under Next.js. ClientService is
            // reused unchanged via a Vite-WS-compatible facade.
            hotServer = new PPDevHotServer({ allowedHosts: _normalized.allowedHosts });

            // What the sync's build needs of the app's Next config: its distDir (the dev phase
            // reports `<distDir>/dev`, `distDirRoot` the configured one), its output, and whether
            // `withPPDev()` wraps the config (its marker; a plain config may carry `ppDev` too),
            // which is what gives that build a distDir of its own.
            const nextConfigWrapped = config?.ppDevWrapped === true || handoff?.wrapped === true;
            // A build without the override exports where the production phase's config says, which
            // a config function may set apart from the development phase's.
            let nextBuildDistDir = nextDistDir;

            if (!nextConfigWrapped) {
              try {
                const productionConfig = await loadConfig(constants.PHASE_PRODUCTION_BUILD, projectRoot);

                nextBuildDistDir = productionConfig?.distDir || nextDistDir;
              } catch {
                // The development phase's distDir stands.
              }
            }

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
                distDir: nextDistDir,
                buildDistDir: nextBuildDistDir,
                output: config?.output,
                configWrapped: nextConfigWrapped,
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

          const server = httpServer;

          // A port in use is an `error` event, not a thrown one: unheard, it ended the process with
          // the uncaught exceptions of three listeners (this server's, Next's) and no word of the port.
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject);

            server.listen(port, host, () => {
              server.off('error', reject);
              resolve();
            });
          });

          {
            // Listening on every address: the URLs are for the one a browser on this machine opens.
            const allAddresses = host === '0.0.0.0' || host === '::';
            const origin = `http://${allAddresses ? 'localhost' : host}:${port}`;

            logger.info(colors.green(`✅ pp-dev Next.js server running at ${origin}`));
            logger.info(colors.blue(`📱 Next.js app accessible at ${origin}${base}`));

            if (allAddresses) {
              logger.info(
                colors.blue(
                  `🌐 Listening on all addresses. A page opened from another device needs this machine's address in allowedDevOrigins (next.config) for Next's HMR, as with next dev -H 0.0.0.0.`,
                ),
              );
            }

            if (inspectorEnabled !== false) {
              logger.info(colors.cyan(`🔍 Request Inspector: ${origin}${INSPECTOR_PATH}`));
            }

            logger.info(colors.blue(`🔧 Base path handling active`));

            // Track open sockets for proper cleanup
            httpServer.on('connection', (socket: any) => {
              openSockets.add(socket);
              socket.on('close', () => openSockets.delete(socket));
            });

            // The supervisor starts the config watcher once the first server is up.
            reportNextServerReady();
          }
        } catch (error: any) {
          if (error?.code === 'EADDRINUSE') {
            logger.error(
              colors.red(
                `❌ Port ${listenPort} is already in use (${listenHost}). Stop what is listening there, or pass another --port.`,
              ),
            );

            process.exit(1);
          }

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
