import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { watch } from 'chokidar';
import { cac } from 'cac';
import { ServerOptions, BuildOptions, LogLevel, InlineConfig, loadEnv } from 'vite';
import { VERSION } from './constants.js';
import { bindShortcuts } from './shortcuts.js';
import { getViteConfig } from './index.js';
import { mergeConfig, build, optimizeDeps, resolveConfig, preview, ViteDevServer, loadConfigFromFile } from 'vite';
import { parse } from 'url';
import { initRewriteResponse } from './lib/rewrite-response.middleware.js';
import { initPPRedirect } from './lib/pp-redirect.middleware.js';
import { MiAPI, MiAPIOptions } from './lib/pp.middleware.js';
import { initProxyCache } from './lib/proxy-cache.middleware.js';
import proxyPassMiddleware from './lib/proxy-pass.middleware.js';
import { initLoadPPData } from './lib/load-pp-data.middleware.js';
import { urlReplacer } from './lib/helpers/url.helper.js';
import { createLogger } from './lib/logger.js';
import { colors } from './lib/helpers/color.helper.js';
import { ChangelogGenerator } from './lib/changelog-generator.js';
import { IconFontGenerator } from './lib/icon-font-generator.js';
// Remove the explicit process import since it's globally available
import internalServer from './lib/internal.middleware';
import { safeNextImport } from './lib/next-import.js';
import { ClientService } from './lib/client.service.js';
import { DistService } from './lib/dist.service.js';
import { PPDevHotServer } from './lib/pp-ws-server.js';
import { injectDevPanel, createDevPanelAssetMiddleware } from './lib/dev-panel.js';
import { PP_DEV_CONFIG_NAMES, PATH_PAGE_PREFIX, PATH_TEMPLATE_PREFIX, PATH_TEMPLATE_LOCAL_PREFIX } from './constants.js';
import { normalizePPDevConfig } from './plugin.js';

const cli = cac('pp-dev');

// Config file watcher utility
interface ConfigWatcher {
  watcher: any;
  restartCallback: () => Promise<void>;
  logger: (message: string) => void;
}

function createConfigWatcher(
  projectRoot: string,
  restartCallback: () => Promise<void>,
  logger: (message: string) => void,
): ConfigWatcher {
  const configFiles = [
    ...PP_DEV_CONFIG_NAMES,
    'package.json',
    'next.config.js',
    'next.config.mjs',
    'next.config.ts',
    'vite.config.js',
    'vite.config.mjs',
    'vite.config.ts',
    '.env',
    '.env.local',
    '.env.development',
    '.env.development.local',
  ];

  const watchPatterns = configFiles.map((file) => path.join(projectRoot, file));

  const watcher = watch(watchPatterns, {
    ignored: (filePath) => {
      const base = path.basename(filePath);

      return (
        /(^|[\/\\])\../.test(filePath) &&
        !base.startsWith('.env') &&
        !base.startsWith('.pp-dev') &&
        !base.startsWith('.pp-watch')
      );
    }, // ignore dotfiles except .env*
    persistent: true,
    ignoreInitial: true,
    followSymlinks: false,
  });

  let restartTimeout: NodeJS.Timeout | null = null;

  watcher.on('change', (filePath) => {
    logger(colors.blue(`🔧 Config file changed: ${path.relative(projectRoot, filePath)}`));

    // Debounce restart to avoid multiple rapid restarts
    if (restartTimeout) {
      clearTimeout(restartTimeout);
    }

    restartTimeout = setTimeout(async () => {
      try {
        logger(colors.yellow(`🔄 Restarting dev server due to config change...`));
        await restartCallback();
      } catch (error: any) {
        logger(colors.red(`❌ Failed to restart dev server: ${error?.message}. Stack: ${error?.stack}`));
      }
    }, 500); // 500ms debounce
  });

  watcher.on('error', (error) => {
    logger(colors.red(`❌ Config watcher error: ${error}`));
  });

  return {
    watcher,
    restartCallback,
    logger,
  };
}

function cleanupConfigWatcher(watcher: ConfigWatcher) {
  if (watcher.watcher) {
    watcher.watcher.close();
  }
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface PPDevBuildOptions extends BuildOptions {
  changelog?: boolean | string;
}

// global options
interface GlobalCLIOptions {
  '--'?: string[];
  c?: boolean | string;
  config?: string;
  base?: string;
  l?: LogLevel;
  logLevel?: LogLevel;
  clearScreen?: boolean;
  d?: boolean | string;
  debug?: boolean | string;
  f?: string;
  filter?: string;
  m?: string;
  mode?: string;
  force?: boolean;
}

/** Extra flags for `pp-dev next` (Next.js custom server bundler selection; Next 15+). */
interface NextCommandCLIOptions extends GlobalCLIOptions {
  /** Use Webpack for dev (same idea as `next dev --webpack`). */
  webpack?: boolean;
  /** Use Turbopack when native bindings are available. */
  turbopack?: boolean;
}

type NextBundlerChoice = { webpack?: boolean; turbopack?: boolean };

function parseNextBundlerCli(opts: NextCommandCLIOptions): NextBundlerChoice {
  const envWebpack = process.env.PP_DEV_NEXT_WEBPACK === '1' || process.env.PP_DEV_NEXT_WEBPACK === 'true';

  if (envWebpack && (opts.webpack || opts.turbopack)) {
    throw new Error('Do not combine PP_DEV_NEXT_WEBPACK with --webpack or --turbopack');
  }

  if (envWebpack) {
    return { webpack: true };
  }

  if (opts.webpack && opts.turbopack) {
    throw new Error('Use only one of --webpack or --turbopack');
  }

  if (opts.webpack) {
    return { webpack: true };
  }

  if (opts.turbopack) {
    return { turbopack: true };
  }

  return {};
}

/** Next dev chose Turbopack but native @next/swc bindings failed (e.g. WDAC on Windows). */
function isNextTurbopackNativeBindingsError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('message' in error)) {
    return false;
  }

  const msg = String((error as Error).message);

  return (
    /Turbopack is not supported/i.test(msg) ||
    /native bindings are not available/i.test(msg) ||
    /Only WebAssembly \(WASM\) bindings were loaded/i.test(msg)
  );
}

interface ChangelogOptions {
  oldAssetsPath?: string;
  newAssetsPath?: string;
  destination?: string;
  filename?: string;
}

interface IconFontOptions {
  source?: string;
  destination?: string;
  fontName?: string;
}

let profileSession = (global as any).__pp_dev_profile_session;
let profileCount = 0;

export const stopProfiler = (log: (message: string) => void): void | Promise<void> => {
  if (!profileSession) {
    return;
  }

  return new Promise((res, rej) => {
    profileSession!.post('Profiler.stop', (err: any, { profile }: any) => {
      // Write profile to disk, upload, etc.
      if (!err) {
        const outPath = path.resolve(`./pp-dev-profile-${profileCount++}.cpuprofile`);
        fs.writeFileSync(outPath, JSON.stringify(profile));
        log(colors.yellow(`CPU profile written to ${colors.white(colors.dim(outPath))}`));
        profileSession = undefined;
        res();
      } else {
        rej(err);
      }
    });
  });
};

const filterDuplicateOptions = <T extends object>(options: T) => {
  for (const [key, value] of Object.entries(options)) {
    if (Array.isArray(value)) {
      options[key as keyof T] = value[value.length - 1];
    }
  }
};
/**
 * removing global flags before passing as command specific sub-configs
 */
function cleanOptions<Options extends GlobalCLIOptions>(options: Options): Omit<Options, keyof GlobalCLIOptions> {
  const ret = { ...options };
  delete ret['--'];
  delete ret.c;
  delete ret.config;
  delete ret.base;
  delete ret.l;
  delete ret.logLevel;
  delete ret.clearScreen;
  delete ret.d;
  delete ret.debug;
  delete ret.f;
  delete ret.filter;
  delete ret.m;
  delete ret.mode;

  return ret;
}

cli
  .option('-c, --config <file>', `[string] use specified config file`)
  .option('--base <path>', `[string] public base path (default: /)`)
  .option('-l, --logLevel <level>', `[string] info | warn | error | silent`)
  .option('--clearScreen', `[boolean] allow/disable clear screen when logging`)
  .option('-d, --debug [feat]', `[string | boolean] show debug logs`)
  .option('-f, --filter <filter>', `[string] filter debug logs`)
  .option('-m, --mode <mode>', `[string] set env mode`);

// dev
cli
  .command('[root]', 'start dev server') // default command
  .alias('serve') // the command is called 'serve' in Vite's API
  .alias('dev') // alias to align with the script name
  .option('--host [host]', `[string] specify hostname`)
  .option('--port <port>', `[number] specify port`)
  .option('--https', `[boolean] use TLS + HTTP/2`)
  .option('--open [path]', `[boolean | string] open browser on startup`)
  .option('--cors', `[boolean] enable CORS`)
  .option('--strictPort', `[boolean] exit if specified port is already in use`)
  .option('--force', `[boolean] force the optimizer to ignore the cache and re-bundle`)
  .action(async (root: string, options: ServerOptions & GlobalCLIOptions) => {
    filterDuplicateOptions(options);

    let server: ViteDevServer | null = null;
    let configWatcher: ConfigWatcher | null = null;
    let isRestarting = false;

    const projectRoot = root ? path.resolve(process.cwd(), root) : process.cwd();
    const logger = createLogger(options.logLevel);

    const startServer = async () => {
      if (isRestarting) return;
      isRestarting = true;

      try {
        // Clean up existing server if any
        if (server) {
          logger.info(colors.yellow('🛑 Stopping existing dev server...'));
          await server.close();
          server = null;
        }

        // Clear config cache
        const { clearConfigCache } = await import('./config.js');
        clearConfigCache();

        // output structure is preserved even after bundling so require()
        // is ok here
        const { createServer } = await import('vite');

        const configFromFile = await loadConfigFromFile(
          { mode: options.mode || 'development', command: 'serve' },
          options.config,
          root,
          options.logLevel,
        );

        let config = await getViteConfig();

        const envVars = loadEnv(options.mode || 'development', root ?? process.cwd(), '');

        if (envVars) {
          Object.keys(envVars).forEach((key) => {
            if (key.startsWith('MI_')) {
              process.env[key] = envVars[key];
            }
          });
        }

        if (configFromFile) {
          const { plugins, ...fileConfig } = configFromFile.config;

          config = mergeConfig(config, fileConfig);
        }

        server = await createServer(
          mergeConfig(
            config,
            {
              root,
              base: options.base,
              mode: options.mode,
              configFile: options.config,
              logLevel: options.logLevel,
              clearScreen: options.clearScreen,
              optimizeDeps: { force: options.force },
              server: cleanOptions(options),
              customLogger: logger,
            },
            true,
          ),
        );

        if (!server.config.base || server.config.base === '/') {
          throw new Error('base cannot be equal to "/" or empty string');
        }

        if (!server.httpServer) {
          throw new Error('HTTP server not available');
        }

        await server.listen();

        const ppDevStartTime = (global as any).__pp_dev_start_time ?? false;
        const startupDurationString = ppDevStartTime
          ? colors.dim(`ready in ${colors.reset(colors.bold(Math.ceil(performance.now() - ppDevStartTime)))} ms`)
          : '';

        logger.info(`\n  ${colors.green(`${colors.bold('PP-DEV')} v${VERSION}`)}  ${startupDurationString}\n`);

        server.printUrls();
        bindShortcuts(server, {
          print: true,
          customShortcuts: [
            ...(profileSession
              ? [
                  {
                    key: 'p',
                    description: 'start/stop the profiler',
                    async action(server: ViteDevServer) {
                      if (profileSession) {
                        await stopProfiler(logger.info);
                      } else {
                        const inspector = await import('node:inspector').then((r) => (r as any).default);

                        await new Promise<void>((res) => {
                          profileSession = new inspector.Session();
                          profileSession.connect();
                          profileSession.post('Profiler.enable', () => {
                            profileSession?.post('Profiler.start', () => {
                              logger.info('Profiler started');

                              res();
                            });
                          });
                        });
                      }
                    },
                  },
                ]
              : []),
            {
              key: 'l',
              description: 'proxy re-login',
              action(server: ViteDevServer): void | Promise<void> {
                server.ws.send({
                  type: 'custom',
                  event: 'redirect',
                  data: {
                    url: `/auth/index/logout?proxyRedirect=${encodeURIComponent('/')}`,
                  },
                });
              },
            },
          ],
        });

        // Set up config watcher
        if (!configWatcher) {
          configWatcher = createConfigWatcher(projectRoot, startServer, logger.info);
          logger.info(colors.blue('🔧 Config file watcher started'));
        }

        isRestarting = false;
      } catch (e: any) {
        isRestarting = false;
        logger.error(colors.red(`error when starting dev server:\n${e.stack}`), {
          error: e,
        });
        stopProfiler(logger.info);
        process.exit(1);
      }
    };

    // Handle graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      logger.info(colors.yellow(`\n🛑 Received ${signal}, shutting down gracefully...`));

      try {
        // Clean up config watcher
        if (configWatcher) {
          cleanupConfigWatcher(configWatcher);
          configWatcher = null;
        }

        // Clean up server
        if (server) {
          await server.close();
          server = null;
        }

        stopProfiler(logger.info);
        logger.info(colors.green('✅ Graceful shutdown completed'));
        process.exit(0);
      } catch (error) {
        logger.error(colors.red(`❌ Error during graceful shutdown: ${error}`));
        process.exit(1);
      }
    };

    // Set up process signal handlers
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('uncaughtException', (error) => {
      logger.error(colors.red(`❌ Uncaught Exception: ${error}`));
      gracefulShutdown('uncaughtException');
    });
    process.on('unhandledRejection', (reason, promise) => {
      logger.error(colors.red(`❌ Unhandled Rejection at: ${promise}, reason: ${reason}`));
      gracefulShutdown('unhandledRejection');
    });

    // Start the server
    await startServer();
  });

// Next.js development server
cli
  .command('next [root]', 'start Next.js development server with pp-dev integration')
  .alias('next-serve')
  .alias('next-dev')
  .option('--host [host]', `[string] specify hostname`)
  .option('--port <port>', `[number] specify port`, { default: 3000 })
  .option('--https', `[boolean] use TLS + HTTP/2`)
  .option('--open [path]', `[boolean | string] open browser on startup`)
  .option('--cors', `[boolean] enable CORS`)
  .option('--strictPort', `[boolean] exit if specified port is already in use`)
  .option('--force', `[boolean] force the optimizer to ignore the cache and re-bundle`)
  .option('--webpack', `[boolean] use Webpack for Next dev (use when Turbopack/native SWC is unavailable)`)
  .option('--turbopack', `[boolean] use Turbopack for Next dev when native bindings work`)
  .action(async (root: string, options: ServerOptions & NextCommandCLIOptions) => {
    filterDuplicateOptions(options);

    let nextApp: ReturnType<typeof import('next').default> | null = null;
    let httpServer: any = null;
    let hotServer: PPDevHotServer | null = null;
    let configWatcher: ConfigWatcher | null = null;
    let isRestarting = false;

    const logger = createLogger();

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
        if (hotServer) {
          await hotServer.close();
          hotServer = null;
        }

        // Clean up existing server if any
        if (httpServer) {
          logger.info(colors.yellow('🛑 Stopping existing Next.js server...'));
          await new Promise<void>((resolve) => {
            httpServer.close(() => {
              httpServer = null;
              resolve();
            });
          });
        }

        // Clean up existing Next.js app if any
        if (nextApp && typeof nextApp.close === 'function') {
          await nextApp.close();

          nextApp = null;
        }

        // Clear config cache
        const { clearConfigCache } = await import('./config.js');
        clearConfigCache();

        const { join, basename } = await import('path');
        const { createServer } = await import('http');

        const importConfig = await import('next/dist/server/config.js');

        const loadConfig: typeof import('next/dist/server/config.js').default =
          (importConfig as any).default.default ||
          (importConfig as any)['module.exports'].default ||
          (importConfig as any).default;

        const opts = cleanOptions(options);

        // Load environment variables
        const envVars = loadEnv(options.mode || 'development', root ?? process.cwd(), '');

        if (envVars) {
          Object.keys(envVars).forEach((key) => {
            if (key.startsWith('MI_')) {
              process.env[key] = envVars[key];
            }
          });
        }

        // Load project root
        const projectRoot = root ? join(process.cwd(), root) : process.cwd();

        logger.info(projectRoot);

        // Get pp-dev config from Next.js app config
        const config = await loadConfig(PHASE_DEVELOPMENT_SERVER, projectRoot);

        // Extract pp-dev configuration from Next.js config
        let ppDevConfig = config?.ppDev || {};

        // If no pp-dev config found in Next.js config, try to load from standalone config file
        if (Object.keys(ppDevConfig).length === 0) {
          try {
            const { getConfig } = await import('./config.js');
            const standaloneConfig = await getConfig();

            if (Object.keys(standaloneConfig).length > 0) {
              ppDevConfig = standaloneConfig;
              logger.info(colors.blue(`🔧 Loaded pp-dev config from standalone config file`));
            } else {
              logger.info(
                colors.yellow('⚠️  No pp-dev config found in Next.js config or standalone file, using defaults'),
              );
            }
          } catch (error) {
            logger.info(colors.yellow('⚠️  Failed to load standalone pp-dev config, using defaults'));
            console.debug('Error loading standalone config:', error);
          }
        } else {
          logger.info(colors.blue(`🔧 Loaded pp-dev config from Next.js config`));
        }

        // Get template name from config, package.json, or fallback to project directory name
        let templateName: string | null = null;

        try {
          const { getPkg } = await import('./config.js');
          const pkg = getPkg();

          templateName = pkg.name;
        } catch {
          // Fallback to project directory name
          templateName = basename(projectRoot);
        }

        // Normalize grouped PPDevConfig to internal flat options
        const _normalized = normalizePPDevConfig(ppDevConfig, templateName ?? '');
        const backendBaseURL = _normalized.backendBaseURL ?? 'http://localhost:8080';
        const templateLess = _normalized.templateLess;
        const v7Features = _normalized.v7Features;
        const disableSSLValidation = _normalized.disableSSLValidation;
        const enableProxyCache = _normalized.enableProxyCache;
        const proxyCacheTTL = _normalized.proxyCacheTTL;
        const personalAccessToken = _normalized.personalAccessToken;
        const miHudLess = _normalized.miHudLess;

        const appId: number =
          _normalized.appId ??
          (process.env.MI_APP_ID ? parseInt(process.env.MI_APP_ID, 10) || undefined : undefined) ??
          (process.env.MI_PORTAL_PAGE_ID ? parseInt(process.env.MI_PORTAL_PAGE_ID, 10) || undefined : undefined) ??
          1;

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

          if (nextApp && typeof nextApp.close === 'function') {
            await nextApp.close();

            nextApp = null;
          }

          const nextOptions: Parameters<typeof next>[0] = {
            dev: true,
            customServer: true,
            hostname: (opts.host as string) || 'localhost',
            port: opts.port,
            dir: projectRoot,
            conf: {
              ...config,
              basePath: base,
              assetPrefix: `${templateLess ? PATH_PAGE_PREFIX : PATH_TEMPLATE_PREFIX}/${templateName}`,
            },
          };

          if (bundler.webpack) {
            nextOptions.webpack = true;
          } else if (bundler.turbopack) {
            nextOptions.turbopack = true;
          }

          nextApp = next(nextOptions);
          await nextApp!.prepare();
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
        const port = typeof opts.port === 'number' ? opts.port : 3000;
        const host = typeof opts.host === 'string' ? opts.host || '0.0.0.0' : 'localhost';

        // Track open sockets for proper cleanup
        const openSockets = new Set<any>();

        // Create HTTP server with base path handling and pp-dev middlewares
        httpServer = createServer(async (req: any, res: any) => {
          try {
            const originalUrl = req.url || '/';
            const originalPathname = originalUrl.split('?')[0];

            let parsedUrl = parse(originalUrl, true);

            // Apply pp-dev middleware chain if available
            if (fullMiddlewareChain.length > 0) {
              // Check if this is an internal Next.js route that should skip most middlewares
              const isInternalNextRoute =
                originalPathname.startsWith('/_next/') ||
                originalPathname === '/favicon.ico' ||
                originalPathname.startsWith('/__nextjs_');

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
              } else if (
                originalPathname.startsWith('/_next/') ||
                originalPathname === '/favicon.ico' ||
                originalPathname.startsWith('/__nextjs_')
              ) {
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
            logger.error(`Error handling request: ${error instanceof Error ? error.message : String(error)}`, { error: error instanceof Error ? error : undefined });
            res.statusCode = 500;
            res.end('Internal Server Error');
          }
        });

        // Initialize pp-dev middlewares
        let mi: MiAPI | null = null;
        /** All pp-dev middlewares for non-internal routes (app pages). Includes redirect, proxy cache, proxy pass, load PP data, internal server, rewrite response. */
        let fullMiddlewareChain: Array<(req: any, res: any, next: () => void) => void> = [];
        /** Essential middlewares for internal Next.js routes (e.g. /_next/, /favicon.ico). Only redirect and internal server; skips proxy/cache for faster static asset handling. */
        let essentialMiddlewareChain: Array<(req: any, res: any, next: () => void) => void> = [];

        if (backendBaseURL) {
          const baseUrlHost = new URL(backendBaseURL).host;

          if (backendBaseURL.startsWith('https://')) {
            EventEmitter.defaultMaxListeners = Math.max(EventEmitter.defaultMaxListeners, 20);
          }

          // Initialize MiAPI
          const miConfig: MiAPIOptions = {
            headers: {
              host: baseUrlHost,
              referer: backendBaseURL,
              origin: backendBaseURL.replace(/^(https?:\/\/)([^/]+)(\/.*)?$/i, '$1$2'),
            },
            appId,
            templateLess,
            disableSSLValidation,
            v7Features,
            personalAccessToken: personalAccessToken ?? process.env.MI_ACCESS_TOKEN,
          };

          mi = new MiAPI(backendBaseURL, miConfig);

          // Create middleware chain for HTTP server
          // Note: We need to adapt Express middlewares to work with raw HTTP requests

          // 1. PP Redirect middleware (essential for all routes)
          const ppRedirectMiddleware = initPPRedirect(base, templateName ?? undefined);
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
            let ttl = +proxyCacheTTL;
            if (!ttl || Number.isNaN(ttl) || ttl < 0) {
              ttl = 10 * 60 * 1000; // 10 minutes
            }

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
          const isIndexRegExp = new RegExp(`^((${escapeRegExp(base)})|/)$`);
          const loadPPDataMiddleware = initLoadPPData(isIndexRegExp, mi, Object.assign({ base }, miConfig, { miHudLess }));
          const loadPPDataWrapper = (req: any, res: any, next: () => void) => {
            loadPPDataMiddleware(req, res, next);
          };

          fullMiddlewareChain.push(loadPPDataWrapper);

          // 4. Proxy Pass middleware (only for non-internal routes)
          const baseWithoutTrailingSlash = base.endsWith('/') ? base.substring(0, base.length - 1) : base;

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
              '/@vite',
              '/@metricinsights',
              '/@',
              baseWithoutTrailingSlash,
              // Next.js internal routes that should not be proxied
              '/_next',
              '/favicon.ico',
              '/__nextjs_',
              '/installHook.js.map',
            ],
            disableSSLValidation,
            miAPI: mi,
            templateName: templateName ?? undefined,
          });

          const proxyPassWrapper = (req: any, res: any, next: () => void) => {
            proxyPassMiddlewareInstance(req, res, next);
          };
          fullMiddlewareChain.push(proxyPassWrapper);

          // 5. Internal Server middleware (API endpoints) - essential for all routes
          const internalServerMiddleware = internalServer;
          const internalServerWrapper = (req: any, res: any, next: () => void) => {
            // Check if this is an internal API request
            if (req.url?.startsWith('/@api/')) {
              const mockNext = () => {};

              internalServerMiddleware(req, res, mockNext);

              return; // Don't call next() for API requests
            }
            next();
          };
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
            (response, req) => {
              const page = mi!.buildPage(response, miHudLess);
              // Inject the dev panel before host-rewriting so its `!!`-prefixed backend
              // links are handled by urlReplacer like the rest of the page.
              const withPanel = injectDevPanel(page, base, {
                backendBaseURL,
                templateLess,
                appId,
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
          hotServer = new PPDevHotServer();

          // The sync `next build` runs in production mode, which writes the static export
          // to the base distDir. Next's dev phase reports distDir as `<distDir>/dev`, so
          // resolve it from the production config and defensively strip a trailing `/dev`.
          // With output:'export', the export lands in distDir (or `out` for the default).
          let exportDistDir: string | undefined = config?.distDir;

          try {
            const prodConfig = await loadConfig(constants.PHASE_PRODUCTION_BUILD, projectRoot);

            exportDistDir = prodConfig?.distDir ?? exportDistDir;
          } catch {
            // Fall back to the dev config's distDir (normalized below).
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

          const distService =
            _normalized.distZip !== false
              ? new DistService(templateName ?? basename(projectRoot), {
                  nextBuild: {
                    projectRoot,
                    distDir: nextExportDir,
                    packageVersion: nextPackageVersion,
                    packageRepositoryUrl: nextPackageRepositoryUrl,
                  },
                })
              : undefined;

          // Minimal ViteDevServer shape consumed by ClientService (`ws` + the v7 flag).
          const clientServiceServer = {
            ws: hotServer.ws,
            config: { clientInjectionPlugin: { v7Features } },
          } as unknown as ViteDevServer;

          new ClientService(clientServiceServer, { distService, miAPI: mi });

          // Route HTTP upgrades: pp-dev WS to our server, everything else (Next.js HMR)
          // to Next's own upgrade handler when available.
          const nextUpgradeHandler =
            typeof (nextApp as any)?.getUpgradeHandler === 'function' ? (nextApp as any).getUpgradeHandler() : null;

          httpServer.on('upgrade', (req: any, socket: any, head: any) => {
            if (hotServer?.handleUpgrade(req, socket, head)) {
              return;
            }

            if (nextUpgradeHandler) {
              nextUpgradeHandler(req, socket, head);
            } else {
              socket.destroy();
            }
          });

          logger.info(colors.blue(`🔧 ${fullMiddlewareChain.length} pp-dev middlewares initialized`));
          logger.info(colors.blue(`🔧 ${essentialMiddlewareChain.length} essential middlewares for internal routes`));
          logger.info(colors.blue(`🔧 MiAPI initialized for backend: ${backendBaseURL}`));
          logger.info(colors.blue(`🔧 Custom App ID: ${appId}`));
        }

        httpServer.listen(port, host, () => {
          logger.info(colors.green(`✅ pp-dev Next.js server running at http://${host}:${port}`));
          logger.info(colors.blue(`📱 Next.js app accessible at http://${host}:${port}${base}`));
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

          // Handle graceful shutdown
          const gracefulShutdown = async (signal: string) => {
            logger.info(colors.yellow(`\n🛑 Received ${signal}, shutting down gracefully...`));

            // Set a timeout to force exit if shutdown hangs
            const shutdownTimeout = setTimeout(() => {
              logger.info(colors.yellow('⏰ Shutdown timeout reached, forcing exit'));
              process.exit(0);
            }, 5000);

            try {
              // Clean up config watcher
              if (configWatcher) {
                cleanupConfigWatcher(configWatcher);
                configWatcher = null;
              }

              // Close all open sockets first
              for (const socket of Array.from(openSockets)) {
                socket.destroy();
              }
              openSockets.clear();

              // Close the dev-panel WebSocket server
              if (hotServer) {
                await hotServer.close();
                hotServer = null;
              }

              // Stop accepting new connections and wait for server to close
              await new Promise<void>((resolve) => {
                httpServer.close(() => {
                  logger.info(colors.yellow('🛑 HTTP server closed'));
                  resolve();
                });
              });

              // Close the Next.js app properly
              if (nextApp && typeof nextApp.close === 'function') {
                await nextApp.close();
                logger.info(colors.yellow('🛑 Next.js app closed'));
              }

              clearTimeout(shutdownTimeout);
              logger.info(colors.green('✅ Graceful shutdown completed'));
              process.exit(0);
            } catch (error) {
              clearTimeout(shutdownTimeout);
              logger.error(colors.red(`❌ Error during graceful shutdown: ${error}`));
              process.exit(1);
            }
          };

          // Handle process signals - try to use process.on if available
          let processObj = process;

          // If local process.on is not available, try global process
          if (typeof process.on !== 'function') {
            const globalProcess = (globalThis as any).process || (global as any).process;

            if (globalProcess && typeof globalProcess.on === 'function') {
              processObj = globalProcess;
              logger.info(colors.green('✅ Using global process object for event handlers'));
            }
          }

          if (typeof processObj.on === 'function') {
            try {
              processObj.on('SIGINT', () => gracefulShutdown('SIGINT'));
              processObj.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

              // Handle uncaught exceptions
              processObj.on('uncaughtException', (error) => {
                logger.error(colors.red(`❌ Uncaught Exception: ${error}`));
                gracefulShutdown('uncaughtException');
              });

              processObj.on('unhandledRejection', (reason, promise) => {
                logger.error(colors.red(`❌ Unhandled Rejection at: ${promise}, reason: ${reason}`));
                gracefulShutdown('unhandledRejection');
              });

              logger.info(colors.green('✅ Process event handlers registered successfully'));
            } catch (error) {
              logger.warn(colors.yellow(`⚠️  Failed to register process event handlers: ${error}`));
            }
          } else {
            logger.warn(
              colors.yellow('⚠️  process.on is not available, graceful shutdown handlers will not be registered'),
            );
            logger.info(colors.blue('💡 This might be due to bundling or environment constraints'));
          }
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

    // Handle graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      logger.info(colors.yellow(`\n🛑 Received ${signal}, shutting down gracefully...`));

      try {
        // Clean up config watcher
        if (configWatcher) {
          cleanupConfigWatcher(configWatcher);
          configWatcher = null;
        }

        // Clean up dev-panel WebSocket server
        if (hotServer) {
          await hotServer.close();
          hotServer = null;
        }

        // Clean up server
        if (httpServer) {
          await new Promise<void>((resolve) => {
            httpServer.close(() => {
              httpServer = null;
              resolve();
            });
          });
        }

        // Clean up Next.js app
        if (nextApp && typeof nextApp.close === 'function') {
          await nextApp.close();
          nextApp = null;
        }

        logger.info(colors.green('✅ Graceful shutdown completed'));
        process.exit(0);
      } catch (error) {
        logger.error(colors.red(`❌ Error during graceful shutdown: ${error}`));
        process.exit(1);
      }
    };

    // Set up process signal handlers
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('uncaughtException', (error) => {
      logger.error(colors.red(`❌ Uncaught Exception: ${error}`));
      gracefulShutdown('uncaughtException');
    });
    process.on('unhandledRejection', (reason, promise) => {
      logger.error(colors.red(`❌ Unhandled Rejection at: ${promise}, reason: ${reason}`));
      gracefulShutdown('unhandledRejection');
    });

    // Start the server
    await startNextServer();
  });

// build
cli
  .command('build [root]', 'build for production')
  .option('--target <target>', `[string] transpile target (default: 'modules')`)
  .option('--outDir <dir>', `[string] output directory (default: dist)`)
  .option('--assetsDir <dir>', `[string] directory under outDir to place assets in (default: assets)`)
  .option('--assetsInlineLimit <number>', `[number] static asset base64 inline threshold in bytes (default: 4096)`)
  .option('--ssr [entry]', `[string] build specified entry for server-side rendering`)
  .option('--sourcemap [output]', `[boolean | "inline" | "hidden"] output source maps for build (default: false)`)
  .option(
    '--minify [minifier]',
    `[boolean | "terser" | "esbuild"] enable/disable minification, ` + `or specify minifier to use (default: esbuild)`,
  )
  .option('--manifest [name]', `[boolean | string] emit build manifest json`)
  .option('--ssrManifest [name]', `[boolean | string] emit ssr manifest json`)
  .option('--force', `[boolean] force the optimizer to ignore the cache and re-bundle (experimental)`)
  .option('--emptyOutDir', `[boolean] force empty outDir when it's outside of root`)
  .option('-w, --watch', `[boolean] rebuilds when modules have changed on disk`)
  .option(
    '--changelog [assetsFile]',
    `[boolean | string] generate changelog between assetsFile and current build (default: false)`,
  )
  .action(async (root: string, options: PPDevBuildOptions & GlobalCLIOptions) => {
    filterDuplicateOptions(options);
    const buildOptions: PPDevBuildOptions = cleanOptions(options);

    try {
      const configFromFile = await loadConfigFromFile(
        { mode: options.mode || 'production', command: 'build' },
        options.config,
        root,
        options.logLevel,
      );

      let config = await getViteConfig();

      if (configFromFile) {
        const { plugins, ...fileConfig } = configFromFile.config;

        config = mergeConfig(config, fileConfig);
      }

      const buildConfig = mergeConfig(
        config,
        {
          root,
          base: options.base,
          mode: options.mode,
          configFile: options.config,
          logLevel: options.logLevel,
          clearScreen: options.clearScreen,
          optimizeDeps: { force: options.force },
          build: buildOptions,
        },
        true,
      ) as InlineConfig;

      await build(buildConfig);

      if (buildOptions.changelog) {
        const executionRoot = root || process.cwd();

        const outDir = buildConfig.build?.outDir || 'dist';

        let oldAssetsPath = '';

        if (typeof buildOptions.changelog === 'string') {
          oldAssetsPath = path.resolve(executionRoot, buildOptions.changelog);
        } else {
          const backupsDirPath = path.resolve(executionRoot, buildConfig.ppDevConfig?.syncBackupsDir || 'backups');

          if (!fs.existsSync(backupsDirPath)) {
            createLogger(options.logLevel).warn(
              colors.yellow(`backups directory not found, skipping changelog generation`),
            );

            return;
          }

          const backups = fs.readdirSync(backupsDirPath, {
            withFileTypes: true,
          });

          if (!backups.length) {
            createLogger(options.logLevel).warn(colors.yellow(`no backups found, skipping changelog generation`));

            return;
          }

          const zipBackups = backups.filter((value) => {
            return value.isFile() && value.name.endsWith('.zip');
          });

          if (!zipBackups.length) {
            createLogger(options.logLevel).warn(colors.yellow(`no ZIP backups found, skipping changelog generation`));

            return;
          }

          const latestBackup = zipBackups.reduce((latest, current) => {
            const latestTime = fs.statSync(path.resolve(backupsDirPath, latest.name)).mtimeMs;
            const currentTime = fs.statSync(path.resolve(backupsDirPath, current.name)).mtimeMs;

            return latestTime > currentTime ? latest : current;
          }).name;

          oldAssetsPath = path.resolve(backupsDirPath, latestBackup);
        }

        const currentAssetFilePath = path.resolve(executionRoot, outDir);

        let changelogDestination = 'dist-zip';

        if (buildConfig.ppDevConfig) {
          if (buildConfig.ppDevConfig.distZip === false) {
            changelogDestination = (buildConfig.build?.outDir as string) || 'dist';
          } else if (
            typeof buildConfig.ppDevConfig.distZip === 'object' &&
            typeof buildConfig.ppDevConfig.distZip.outDir === 'string'
          ) {
            changelogDestination = buildConfig.ppDevConfig.distZip.outDir;
          }
        }

        const changelogGenerator = new ChangelogGenerator({
          oldAssetsPath,
          newAssetsPath: currentAssetFilePath,
          destinationPath: path.resolve(executionRoot, changelogDestination),
        });

        await changelogGenerator.generateChangelog();
      }
    } catch (e: any) {
      createLogger(options.logLevel).error(colors.red(`error during build:\n${e.stack}`), { error: e });

      process.exit(1);
    } finally {
      stopProfiler((message) => createLogger(options.logLevel).info(message));
    }
  });

// changelog
cli
  .command('changelog [oldAssetPath] [newAssetPath]', 'generate changelog between two assets files/folders')
  .option('--oldAssetsPath <oldAssetsPath>', `[string] path to the old assets zip file or folder`)
  .option('--newAssetsPath <newAssetsPath>', `[string] path to the new assets zip file or folder`)
  .option('--destination <destination>', `[string] destination folder for the changelog (default: .)`)
  .option('--filename <filename>', `[string] filename for the changelog (default: CHANGELOG.html)`)
  .action(async (oldAssetPath: string, newAssetPath: string, options: ChangelogOptions & GlobalCLIOptions) => {
    filterDuplicateOptions(options);

    const {
      oldAssetsPath: oldPath = oldAssetPath,
      newAssetsPath: newPath = newAssetPath,
      destination = '.',
      filename = 'CHANGELOG.html',
      logLevel,
    } = options;

    const root = process.cwd();

    if (!oldPath || !newPath) {
      createLogger(logLevel).error(
        colors.red(`error during changelog generation: oldAssetPath and newAssetPath are required`),
      );

      process.exit(1);
    }

    const fullOldPath = path.resolve(root, oldPath);
    const fullNewPath = path.resolve(root, newPath);
    const fullDestination = path.resolve(root, destination);

    const changelogGenerator = new ChangelogGenerator({
      oldAssetsPath: fullOldPath,
      newAssetsPath: fullNewPath,
      destinationPath: fullDestination,
      changelogFilename: filename,
    });

    await changelogGenerator.generateChangelog();
  });

cli
  .command('generate-icon-font [source] [destination]', 'generate icon font from SVG files')
  .option('--source <source>', `[string] path to the source directory with SVG files`)
  .option('--destination <destination>', `[string] path to the destination directory to save the generated font files`)
  .option('--font-name, -n <fontName>', `[string] name of the font to generate (default: 'icon-font')`)
  .action(async (source: string, destination: string, options: IconFontOptions & GlobalCLIOptions) => {
    filterDuplicateOptions(options);

    const { source: sourceDir = source, destination: destDir = destination, fontName = 'icon-font' } = options;

    const root = process.cwd();

    const fullSourceDir = path.resolve(root, sourceDir);
    const fullDestDir = path.resolve(root, destDir);

    const iconFontGenerator = new IconFontGenerator({
      sourceDir: fullSourceDir,
      outputDir: fullDestDir,
      fontName,
    });

    const logger = createLogger(options.logLevel);

    logger.info(`Generating icon font from SVG files in ${colors.dim(fullSourceDir)}`);

    await iconFontGenerator.generate();

    logger.info(`Icon font generated and saved to ${colors.dim(fullDestDir)}`);
  });

// optimize
cli
  .command('optimize [root]', 'pre-bundle dependencies')
  .option('--force', `[boolean] force the optimizer to ignore the cache and re-bundle`)
  .action(async (root: string, options: { force?: boolean } & GlobalCLIOptions) => {
    filterDuplicateOptions(options);
    try {
      const configFromFile = await loadConfigFromFile(
        { mode: options.mode || 'production', command: 'build' },
        options.config,
        root,
        options.logLevel,
      );

      let config = await getViteConfig();

      if (configFromFile) {
        const { plugins, ...fileConfig } = configFromFile.config;

        config = mergeConfig(config, fileConfig);
      }

      const optimizeConfig = await resolveConfig(
        mergeConfig(config, {
          root,
          base: options.base,
          configFile: options.config,
          logLevel: options.logLevel,
          mode: options.mode,
        }),
        'serve',
      );

      await optimizeDeps(optimizeConfig, options.force, true);
    } catch (e: any) {
      createLogger(options.logLevel).error(colors.red(`error when optimizing deps:\n${e.stack}`), { error: e });

      process.exit(1);
    }
  });

cli
  .command('preview [root]', 'locally preview production build')
  .option('--host [host]', `[string] specify hostname`)
  .option('--port <port>', `[number] specify port`)
  .option('--strictPort', `[boolean] exit if specified port is already in use`)
  .option('--https', `[boolean] use TLS + HTTP/2`)
  .option('--open [path]', `[boolean | string] open browser on startup`)
  .option('--outDir <dir>', `[string] output directory (default: dist)`)
  .action(
    async (
      root: string,
      options: {
        host?: string | boolean;
        port?: number;
        https?: boolean;
        open?: boolean | string;
        strictPort?: boolean;
        outDir?: string;
      } & GlobalCLIOptions,
    ) => {
      filterDuplicateOptions(options);

      try {
        const configFromFile = await loadConfigFromFile(
          { mode: options.mode || 'production', command: 'build' },
          options.config,
          root,
          options.logLevel,
        );

        let config = await getViteConfig();

        if (configFromFile) {
          const { plugins, ...fileConfig } = configFromFile.config;

          config = mergeConfig(config, fileConfig);
        }

        const server = await preview(
          mergeConfig(config, {
            root,
            base: options.base,
            configFile: options.config,
            logLevel: options.logLevel,
            mode: options.mode,
            build: {
              outDir: options.outDir,
            },
            preview: {
              port: options.port,
              strictPort: options.strictPort,
              host: options.host,
              https: options.https,
              open: options.open,
            },
          }),
        );

        server.printUrls();
      } catch (e: any) {
        createLogger(options.logLevel).error(colors.red(`error when starting preview server:\n${e.stack}`), {
          error: e,
        });

        process.exit(1);
      } finally {
        stopProfiler((message) => createLogger(options.logLevel).info(message));
      }
    },
  );

// migrate
cli
  .command('migrate [config]', 'migrate pp-dev config from 0.x flat format to 1.0 grouped format')
  .option('--dry-run', '[boolean] print migrated config without writing any files')
  .option('--format <format>', '[string] output format: ts (default), js, json')
  .option('--output <file>', '[string] output file path (default: pp-dev.config.ts)')
  .option('--no-backup', '[boolean] skip backup of original config file')
  .action(
    async (
      configArg: string | undefined,
      options: { dryRun?: boolean; format?: string; output?: string; backup?: boolean } & GlobalCLIOptions,
    ) => {
      const logger = createLogger(options.logLevel);

      const {
        isLegacyFlatConfig,
        isLegacyPPWatchConfig,
        isAlreadyMigrated,
        migrateLegacyFlatConfig,
        migratePPWatchConfig,
        generateConfigFileContent,
      } = await import('./lib/migrate.js');

      const format = (options.format ?? 'ts') as 'ts' | 'js' | 'json';
      const doBackup = options.backup !== false;
      const projectRoot = process.cwd();

      // Discover config file to migrate
      const watchConfigNames = [
        '.pp-watch.config.ts',
        '.pp-watch.config.js',
        '.pp-watch.config.json',
        'pp-watch.config.ts',
        'pp-watch.config.js',
        'pp-watch.config.json',
      ];

      let sourceFile: string | null = configArg ?? null;
      let isWatchConfig = false;

      if (!sourceFile) {
        // Try pp-dev config files first
        for (const name of PP_DEV_CONFIG_NAMES) {
          if (fs.existsSync(path.join(projectRoot, name))) {
            sourceFile = path.join(projectRoot, name);
            break;
          }
        }
        // Fall back to pp-watch config files
        if (!sourceFile) {
          for (const name of watchConfigNames) {
            if (fs.existsSync(path.join(projectRoot, name))) {
              sourceFile = path.join(projectRoot, name);
              isWatchConfig = true;
              break;
            }
          }
        }
      }

      if (!sourceFile) {
        logger.warn(colors.yellow('No pp-dev or pp-watch config file found in the current directory.'));
        logger.info(colors.blue('Supported files: pp-dev.config.{ts,js,cjs,mjs,json}, .pp-watch.config.{ts,js,json}'));
        process.exit(1);
      }

      logger.info(colors.blue(`Found config: ${path.relative(projectRoot, sourceFile)}`));

      // Load the config
      const { getConfig, getPkg } = await import('./config.js');
      const pkg = getPkg();
      let rawConfig: Record<string, unknown> = {};

      try {
        // Use a temporary import that bypasses the new PPDevConfig type
        if (/\.[cm]?ts$/i.test(sourceFile)) {
          const esbuild = await import('esbuild');
          const { pathToFileURL } = await import('url');
          const result = await esbuild.build({
            absWorkingDir: projectRoot,
            entryPoints: [sourceFile],
            outfile: 'out.js',
            write: false,
            target: ['node18'],
            platform: 'node',
            bundle: true,
            format: 'esm',
            mainFields: ['main'],
          });
          const code = result.outputFiles[0].text;
          const tmpFile = `pp-migrate-tmp-${Date.now()}.mjs`;
          fs.writeFileSync(tmpFile, code);
          try {
            const mod = await import(pathToFileURL(path.resolve(projectRoot, tmpFile)).toString());
            rawConfig = mod.default?.default ?? mod.default ?? mod;
          } finally {
            if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
          }
        } else if (/\.[cm]?js$/i.test(sourceFile)) {
          const { pathToFileURL } = await import('url');
          const mod = await import(pathToFileURL(path.resolve(projectRoot, sourceFile)).toString());
          rawConfig = mod.default?.default ?? mod.default ?? mod;
        } else if (sourceFile.endsWith('.json')) {
          rawConfig = JSON.parse(fs.readFileSync(sourceFile, 'utf-8'));
        }
      } catch (e: any) {
        logger.error(colors.red(`Failed to load config file: ${e.message}`));
        process.exit(1);
      }

      if (!rawConfig || typeof rawConfig !== 'object') {
        logger.error(colors.red('Config file did not export a valid object.'));
        process.exit(1);
      }

      // Detect format and migrate
      let migratedConfig;

      if (isAlreadyMigrated(rawConfig)) {
        logger.info(colors.green('Config is already in 1.0 format — nothing to migrate.'));
        process.exit(0);
      } else if (isWatchConfig || isLegacyPPWatchConfig(rawConfig)) {
        logger.info(colors.blue('Detected pp-watch config format → migrating to 1.0'));
        migratedConfig = migratePPWatchConfig(rawConfig as any);
      } else if (isLegacyFlatConfig(rawConfig)) {
        logger.info(colors.blue('Detected 0.x flat config format → migrating to 1.0'));
        migratedConfig = migrateLegacyFlatConfig(rawConfig, pkg.name);
      } else {
        logger.warn(colors.yellow('Could not detect config format. No known keys found.'));
        process.exit(1);
      }

      const outputContent = generateConfigFileContent(migratedConfig, format);
      const outputFile = options.output ?? path.join(projectRoot, `pp-dev.config.${format}`);

      if (options.dryRun) {
        logger.info(colors.green(`\n--- Migrated config (dry-run) → ${path.relative(projectRoot, outputFile)} ---\n`));
        console.log(outputContent);
        process.exit(0);
      }

      // Backup original
      if (doBackup && fs.existsSync(sourceFile)) {
        const backupPath = `${sourceFile}.bak`;
        fs.copyFileSync(sourceFile, backupPath);
        logger.info(colors.blue(`Backed up original to: ${path.relative(projectRoot, backupPath)}`));
      }

      fs.writeFileSync(outputFile, outputContent, 'utf-8');
      logger.info(colors.green(`✅ Migration complete → ${path.relative(projectRoot, outputFile)}`));

      if (sourceFile !== outputFile && fs.existsSync(sourceFile)) {
        logger.info(colors.yellow(`You can now delete the old config: ${path.relative(projectRoot, sourceFile)}`));
      }
    },
  );

cli.help();
cli.version(VERSION);

cli.parse();
