import * as path from "path";
import * as fs from "fs";
import { performance } from "node:perf_hooks";
import { watch } from "chokidar";
import { cac } from "cac";
import {
  ServerOptions,
  BuildOptions,
  LogLevel,
  InlineConfig,
  loadEnv,
} from "vite";
import { VERSION } from "./constants.js";
import { bindShortcuts } from "./shortcuts.js";
import { getViteConfig } from "./index.js";
import {
  mergeConfig,
  build,
  optimizeDeps,
  resolveConfig,
  preview,
  ViteDevServer,
  loadConfigFromFile,
} from "vite";
import { parse } from "url";
import { initRewriteResponse } from "./lib/rewrite-response.middleware.js";
import { initPPRedirect } from "./lib/pp-redirect.middleware.js";
import { MiAPI } from "./lib/pp.middleware.js";
import { initProxyCache } from "./lib/proxy-cache.middleware.js";
import proxyPassMiddleware from "./lib/proxy-pass.middleware.js";
import { initLoadPPData } from "./lib/load-pp-data.middleware.js";
import { urlReplacer } from "./lib/helpers/url.helper.js";
import { createLogger } from "./lib/logger.js";
import { colors } from "./lib/helpers/color.helper.js";
import { ChangelogGenerator } from "./lib/changelog-generator.js";
import { IconFontGenerator } from "./lib/icon-font-generator.js";
// Remove the explicit process import since it's globally available
import internalServer from "./lib/internal.middleware";
import { safeNextImport, isNextAvailable } from "./lib/next-import.js";
import { PP_DEV_CONFIG_NAMES, PP_WATCH_CONFIG_NAMES } from "./constants.js";

const cli = cac("pp-dev");

// Config file watcher utility
interface ConfigWatcher {
  watcher: any;
  restartCallback: () => Promise<void>;
  logger: (message: string) => void;
}

function createConfigWatcher(
  projectRoot: string,
  restartCallback: () => Promise<void>,
  logger: (message: string) => void
): ConfigWatcher {
  const configFiles = [
    ...PP_DEV_CONFIG_NAMES,
    ...PP_WATCH_CONFIG_NAMES,
    "package.json",
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
    "vite.config.js",
    "vite.config.mjs", 
    "vite.config.ts",
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local"
  ];

  const watchPatterns = configFiles.map(file => path.join(projectRoot, file));
  
  const watcher = watch(watchPatterns, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
    ignoreInitial: true,
    followSymlinks: false
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
      } catch (error) {
        logger(colors.red(`❌ Failed to restart dev server: ${error}`));
      }
    }, 500); // 500ms debounce
  });

  watcher.on('error', (error) => {
    logger(colors.red(`❌ Config watcher error: ${error}`));
  });

  return {
    watcher,
    restartCallback,
    logger
  };
}

function cleanupConfigWatcher(watcher: ConfigWatcher) {
  if (watcher.watcher) {
    watcher.watcher.close();
  }
}

interface PPDevBuildOptions extends BuildOptions {
  changelog?: boolean | string;
}

// global options
interface GlobalCLIOptions {
  "--"?: string[];
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

export const stopProfiler = (
  log: (message: string) => void
): void | Promise<void> => {
  if (!profileSession) {
    return;
  }

  return new Promise((res, rej) => {
    profileSession!.post("Profiler.stop", (err: any, { profile }: any) => {
      // Write profile to disk, upload, etc.
      if (!err) {
        const outPath = path.resolve(
          `./pp-dev-profile-${profileCount++}.cpuprofile`
        );
        fs.writeFileSync(outPath, JSON.stringify(profile));
        log(
          colors.yellow(
            `CPU profile written to ${colors.white(colors.dim(outPath))}`
          )
        );
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
function cleanOptions<Options extends GlobalCLIOptions>(
  options: Options
): Omit<Options, keyof GlobalCLIOptions> {
  const ret = { ...options };
  delete ret["--"];
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
  .option("-c, --config <file>", `[string] use specified config file`)
  .option("--base <path>", `[string] public base path (default: /)`)
  .option("-l, --logLevel <level>", `[string] info | warn | error | silent`)
  .option("--clearScreen", `[boolean] allow/disable clear screen when logging`)
  .option("-d, --debug [feat]", `[string | boolean] show debug logs`)
  .option("-f, --filter <filter>", `[string] filter debug logs`)
  .option("-m, --mode <mode>", `[string] set env mode`);

// dev
cli
  .command("[root]", "start dev server") // default command
  .alias("serve") // the command is called 'serve' in Vite's API
  .alias("dev") // alias to align with the script name
  .option("--host [host]", `[string] specify hostname`)
  .option("--port <port>", `[number] specify port`)
  .option("--https", `[boolean] use TLS + HTTP/2`)
  .option("--open [path]", `[boolean | string] open browser on startup`)
  .option("--cors", `[boolean] enable CORS`)
  .option("--strictPort", `[boolean] exit if specified port is already in use`)
  .option(
    "--force",
    `[boolean] force the optimizer to ignore the cache and re-bundle`
  )
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
          logger.info(colors.yellow("🛑 Stopping existing dev server..."));
          await server.close();
          server = null;
        }

        // Clear config cache
        const { clearConfigCache } = await import("./config.js");
        clearConfigCache();

        // output structure is preserved even after bundling so require()
        // is ok here
        const { createServer } = await import("vite");

        const configFromFile = await loadConfigFromFile(
          { mode: options.mode || "development", command: "serve" },
          options.config,
          root,
          options.logLevel
        );

        let config = await getViteConfig();

        const envVars = loadEnv(
          options.mode || "development",
          root ?? process.cwd(),
          ""
        );

        if (envVars) {
          Object.keys(envVars).forEach((key) => {
            if (key.startsWith("MI_")) {
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
            true
          )
        );

        if (!server.config.base || server.config.base === "/") {
          throw new Error('base cannot be equal to "/" or empty string');
        }

        if (!server.httpServer) {
          throw new Error("HTTP server not available");
        }

        await server.listen();

        const ppDevStartTime = (global as any).__pp_dev_start_time ?? false;
        const startupDurationString = ppDevStartTime
          ? colors.dim(
              `ready in ${colors.reset(
                colors.bold(Math.ceil(performance.now() - ppDevStartTime))
              )} ms`
            )
          : "";

        logger.info(
          `\n  ${colors.green(
            `${colors.bold("PP-DEV")} v${VERSION}`
          )}  ${startupDurationString}\n`
        );

        server.printUrls();
        bindShortcuts(server, {
          print: true,
          customShortcuts: [
            ...(profileSession
              ? [
                  {
                    key: "p",
                    description: "start/stop the profiler",
                    async action(server: ViteDevServer) {
                      if (profileSession) {
                        await stopProfiler(logger.info);
                      } else {
                        const inspector = await import("node:inspector").then(
                          (r) => (r as any).default
                        );

                        await new Promise<void>((res) => {
                          profileSession = new inspector.Session();
                          profileSession.connect();
                          profileSession.post("Profiler.enable", () => {
                            profileSession?.post("Profiler.start", () => {
                              logger.info("Profiler started");

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
              key: "l",
              description: "proxy re-login",
              action(server: ViteDevServer): void | Promise<void> {
                server.ws.send({
                  type: "custom",
                  event: "redirect",
                  data: {
                    url: `/auth/index/logout?proxyRedirect=${encodeURIComponent(
                      "/"
                    )}`,
                  },
                });
              },
            },
          ],
        });

        // Set up config watcher
        if (!configWatcher) {
          configWatcher = createConfigWatcher(projectRoot, startServer, logger.info);
          logger.info(colors.blue("🔧 Config file watcher started"));
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
      logger.info(
        colors.yellow(
          `\n🛑 Received ${signal}, shutting down gracefully...`
        )
      );

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
        logger.info(colors.green("✅ Graceful shutdown completed"));
        process.exit(0);
      } catch (error) {
        logger.error(colors.red(`❌ Error during graceful shutdown: ${error}`));
        process.exit(1);
      }
    };

    // Set up process signal handlers
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("uncaughtException", (error) => {
      logger.error(colors.red(`❌ Uncaught Exception: ${error}`));
      gracefulShutdown("uncaughtException");
    });
    process.on("unhandledRejection", (reason, promise) => {
      logger.error(
        colors.red(
          `❌ Unhandled Rejection at: ${promise}, reason: ${reason}`
        )
      );
      gracefulShutdown("unhandledRejection");
    });

    // Start the server
    await startServer();
  });

// Next.js development server
cli
  .command(
    "next [root]",
    "start Next.js development server with pp-dev integration"
  )
  .alias("next-serve")
  .alias("next-dev")
  .option("--host [host]", `[string] specify hostname`)
  .option("--port <port>", `[number] specify port`, { default: 3000 })
  .option("--https", `[boolean] use TLS + HTTP/2`)
  .option("--open [path]", `[boolean | string] open browser on startup`)
  .option("--cors", `[boolean] enable CORS`)
  .option("--strictPort", `[boolean] exit if specified port is already in use`)
  .option(
    "--force",
    `[boolean] force the optimizer to ignore the cache and re-bundle`
  )
  .action(async (root: string, options: ServerOptions & GlobalCLIOptions) => {
    filterDuplicateOptions(options);

    let nextApp: any = null;
    let httpServer: any = null;
    let configWatcher: ConfigWatcher | null = null;
    let isRestarting = false;

    const projectRoot = root ? path.resolve(process.cwd(), root) : process.cwd();
    const logger = createLogger();

    const startNextServer = async () => {
      if (isRestarting) return;
      isRestarting = true;

      try {
        // Clean up existing server if any
        if (httpServer) {
          logger.info(colors.yellow("🛑 Stopping existing Next.js server..."));
          await new Promise<void>((resolve) => {
            httpServer.close(() => {
              httpServer = null;
              resolve();
            });
          });
        }

        // Clean up existing Next.js app if any
        if (nextApp && typeof nextApp.close === "function") {
          await nextApp.close();
          nextApp = null;
        }

        // Clear config cache
        const { clearConfigCache } = await import("./config.js");
        clearConfigCache();

        // Check if Next.js is available before proceeding
        if (!isNextAvailable()) {
          throw new Error(
            "Next.js is required but not available. Please install Next.js as a dependency:\n" +
              "npm install next@^13\n\n" +
              "This package requires Next.js >=13 <16 as a peer dependency."
          );
        }

        const { next } = await safeNextImport();
        const { join, basename } = await import("path");
        const { createServer } = await import("http");
        const { default: loadConfig } = (
          await import("next/dist/server/config.js")
        ).default as any;

        const opts = cleanOptions(options);

      // Load environment variables
      const envVars = loadEnv(
        options.mode || "development",
        root ?? process.cwd(),
        ""
      );
      if (envVars) {
        Object.keys(envVars).forEach((key) => {
          if (key.startsWith("MI_")) {
            process.env[key] = envVars[key];
          }
        });
      }

      // Load project root
      const projectRoot = root ? join(process.cwd(), root) : process.cwd();

      logger.info(projectRoot);

      // Get pp-dev config from Next.js app config
      const config = await loadConfig("development", projectRoot);
      // Extract pp-dev configuration from Next.js config
      let ppDevConfig = config?.experimental?.ppDev || config?.ppDev || {};

      // If no pp-dev config found in Next.js config, try to load from standalone config file
      if (Object.keys(ppDevConfig).length === 0) {
        try {
          const { getConfig } = await import("./config.js");
          const standaloneConfig = await getConfig();

          if (Object.keys(standaloneConfig).length > 0) {
            ppDevConfig = standaloneConfig;
            logger.info(
              colors.blue(`🔧 Loaded pp-dev config from standalone config file`)
            );
          } else {
            logger.info(
              colors.yellow(
                "⚠️  No pp-dev config found in Next.js config or standalone file, using defaults"
              )
            );
          }
        } catch (error) {
          logger.info(
            colors.yellow(
              "⚠️  Failed to load standalone pp-dev config, using defaults"
            )
          );
          console.debug("Error loading standalone config:", error);
        }
      } else {
        logger.info(colors.blue(`🔧 Loaded pp-dev config from Next.js config`));
      }

      // Extract configuration values with defaults
      const {
        backendBaseURL = process.env.MI_BACKEND_URL || "http://localhost:8080",
        portalPageId = parseInt(process.env.MI_PORTAL_PAGE_ID || "1"),
        templateLess = true,
        v7Features = true,
        disableSSLValidation = false,
        enableProxyCache = true,
        proxyCacheTTL = 600000,
        personalAccessToken = process.env.MI_ACCESS_TOKEN,
        distZip = false,
        syncBackupsDir = "./backups",
        miHudLess = false,
      } = ppDevConfig;

      // Get template name from config, package.json, or fallback to project directory name
      let templateName = ppDevConfig.templateName;

      if (!templateName) {
        try {
          const { getPkg } = await import("./config.js");
          const pkg = getPkg();
          templateName = pkg.name;
        } catch (error) {
          // Fallback to project directory name
          templateName = basename(projectRoot);
        }
      }

      // Calculate base path using the same logic as the plugin
      const pathPagePrefix = "/p"; // templateLess = true - use /p
      const pathTemplatePrefix = "/pl"; // templateLess = false && v7Features = true - use /pl

      let base = templateLess ? pathPagePrefix : pathTemplatePrefix;
      base += `/${templateName}`;

      nextApp = next({
        dev: true,
        hostname: (opts.host as string) || "localhost",
        port: opts.port,
        dir: projectRoot,
        conf: {
          ...config,
          basePath: base,
          assetPrefix: base, // Fixed: Make assetPrefix consistent with basePath
        },
      });

      await nextApp.prepare();

      // Default to templateLess = true for Next.js development
      // const templateLess =
      //   typeof ppDevConfig.templateLess === "boolean"
      //     ? ppDevConfig.templateLess
      //     : true;

      if (!base.endsWith("/")) {
        base += "/";
      }

      if (base === "/") {
        throw new Error(
          'basePath cannot be equal to "/" or equal to empty string'
        );
      }

      const baseWithoutTrailingSlash = base.substring(0, base.lastIndexOf("/"));

      // Log the configuration
      logger.info(colors.green("✅ Next.js app prepared successfully"));
      logger.info(
        colors.blue(`🔧 pp-dev plugin configured for template: ${templateName}`)
      );
      logger.info(colors.blue(`🔧 Base path configured: ${base}`));

      if (backendBaseURL) {
        logger.info(colors.blue(`🌐 Backend URL: ${backendBaseURL}`));
        logger.info(colors.blue(`🆔 Portal Page ID: ${portalPageId}`));
      }

      // Get the Next.js request handler
      const handle = nextApp.getRequestHandler();

      // Start the server
      const port = typeof opts.port === "number" ? opts.port : 3000;
      const host = typeof opts.host === "string" ? (opts.host || '0.0.0.0') : "localhost";

      // Track open sockets for proper cleanup
      const openSockets = new Set<any>();

      // Create HTTP server with base path handling and pp-dev middlewares
      httpServer = createServer(async (req: any, res: any) => {
        try {
          const originalUrl = req.url || "/";
          const originalPathname = originalUrl.split("?")[0];

          let parsedUrl = parse(originalUrl, true);

          // Apply pp-dev middleware chain if available
          if (fullMiddlewareChain.length > 0) {
            // Check if this is an internal Next.js route that should skip most middlewares
            const isInternalNextRoute =
              originalPathname.startsWith("/_next/") ||
              originalPathname === "/favicon.ico" ||
              originalPathname.startsWith("/__nextjs_") ||
              originalPathname.startsWith("/api/");

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
            // Handle base path requests
            if (originalPathname.startsWith(base)) {
              // Strip the base path for Next.js
              const nextPath = originalPathname.substring(base.length);

              req.url = nextPath || "/";
              parsedUrl = parse(nextPath, true);
            } else if (originalPathname === base.replace(/\/$/, "")) {
              // Handle base path without trailing slash
              req.url = "/";
              parsedUrl = parse("/", true);
            } else if (
              originalPathname.startsWith("/_next/") ||
              originalPathname === "/favicon.ico" ||
              originalPathname.startsWith("/__nextjs_")
            ) {
              // Next.js internal routes - pass through as-is
            } else if (originalPathname === "/") {
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
          console.error(`[DEBUG] Error:`, error);
          res.statusCode = 500;
          res.end("Internal Server Error");
        }
      });

      // Initialize pp-dev middlewares
      let mi: MiAPI | null = null;
      let fullMiddlewareChain: Array<
        (req: any, res: any, next: () => void) => void
      > = [];
      let essentialMiddlewareChain: Array<
        (req: any, res: any, next: () => void) => void
      > = [];

      if (backendBaseURL) {
        const baseUrlHost = new URL(backendBaseURL).host;

        // Initialize MiAPI
        const miConfig = {
          headers: {
            host: baseUrlHost,
            referer: backendBaseURL,
            origin: backendBaseURL.replace(
              /^(https?:\/\/)([^/]+)(\/.*)?$/i,
              "$1$2"
            ),
          },
          portalPageId,
          appId: portalPageId,
          templateLess,
          disableSSLValidation,
          v7Features,
          personalAccessToken:
            personalAccessToken ?? process.env.MI_ACCESS_TOKEN,
        };

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

          logger.info(
            colors.blue(`🔧 Proxy cache middleware added with TTL: ${ttl}ms`)
          );
        }

        // 3. Proxy Pass middleware (only for non-internal routes)
        const baseWithoutTrailingSlash = base.endsWith("/")
          ? base.substring(0, base.length - 1)
          : base;

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
            "/@vite",
            "/@metricinsights",
            "/@",
            baseWithoutTrailingSlash,
            // Next.js internal routes that should not be proxied
            "/_next",
            "/favicon.ico",
            "/__nextjs_",
            "/api",
          ],
          disableSSLValidation,
          miAPI: mi,
        }) as any;

        const proxyPassWrapper = (req: any, res: any, next: () => void) => {
          proxyPassMiddlewareInstance(req, res, next);
        };
        fullMiddlewareChain.push(proxyPassWrapper);

        // 4. Load PP Data middleware (only for non-internal routes)
        const isIndexRegExp = new RegExp(`^((${base})|/)$`);
        const loadPPDataMiddleware = initLoadPPData(isIndexRegExp, mi, { base, v7Features });
        const loadPPDataWrapper = (req: any, res: any, next: () => void) => {
          loadPPDataMiddleware(req, res, next);
        };
        fullMiddlewareChain.push(loadPPDataWrapper);

        // 5. Internal Server middleware (API endpoints) - essential for all routes
        const internalServerMiddleware = internalServer;
        const internalServerWrapper = (
          req: any,
          res: any,
          next: () => void
        ) => {
          // Check if this is an internal API request
          if (req.url?.startsWith("/@api/")) {
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
            return url.split("?")[0].endsWith("index.html");
          },
          (response, req) => {
            return Buffer.from(
              urlReplacer(
                baseUrlHost,
                req.headers.host ?? "",
                mi!.buildPage(response, miHudLess)
              )
            );
          }
        );

        const rewriteResponseWrapper = (
          req: any,
          res: any,
          next: () => void
        ) => {
          rewriteResponseMiddleware(req, res, next);
        };
        fullMiddlewareChain.push(rewriteResponseWrapper);

        logger.info(
          colors.blue(
            `🔧 ${fullMiddlewareChain.length} pp-dev middlewares initialized`
          )
        );
        logger.info(
          colors.blue(
            `🔧 ${essentialMiddlewareChain.length} essential middlewares for internal routes`
          )
        );
        logger.info(
          colors.blue(`🔧 MiAPI initialized for backend: ${backendBaseURL}`)
        );
        logger.info(colors.blue(`🔧 Portal Page ID: ${portalPageId}`));
      }

      httpServer.listen(port, host, () => {
        logger.info(
          colors.green(
            `✅ pp-dev Next.js server running at http://${host}:${port}`
          )
        );
        logger.info(
          colors.blue(
            `📱 Next.js app accessible at http://${host}:${port}${base}`
          )
        );
        logger.info(colors.blue(`🔧 Base path handling active`));

        // Set up config watcher
        if (!configWatcher) {
          configWatcher = createConfigWatcher(projectRoot, startNextServer, logger.info);
          logger.info(colors.blue("🔧 Config file watcher started"));
        }

        // Track open sockets for proper cleanup
        httpServer.on("connection", (socket: any) => {
          openSockets.add(socket);
          socket.on("close", () => openSockets.delete(socket));
        });

        // Handle graceful shutdown
        const gracefulShutdown = async (signal: string) => {
          logger.info(
            colors.yellow(
              `\n🛑 Received ${signal}, shutting down gracefully...`
            )
          );

          // Set a timeout to force exit if shutdown hangs
          const shutdownTimeout = setTimeout(() => {
            logger.info(
              colors.yellow("⏰ Shutdown timeout reached, forcing exit")
            );
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

            // Stop accepting new connections and wait for server to close
            await new Promise<void>((resolve) => {
              httpServer.close(() => {
                logger.info(colors.yellow("🛑 HTTP server closed"));
                resolve();
              });
            });

            // Close the Next.js app properly
            if (nextApp && typeof nextApp.close === "function") {
              await nextApp.close();
              logger.info(colors.yellow("🛑 Next.js app closed"));
            }

            clearTimeout(shutdownTimeout);
            logger.info(colors.green("✅ Graceful shutdown completed"));
            process.exit(0);
          } catch (error) {
            clearTimeout(shutdownTimeout);
            logger.error(
              colors.red(`❌ Error during graceful shutdown: ${error}`)
            );
            process.exit(1);
          }
        };

        // Handle process signals - try to use process.on if available
        let processObj = process;

        // If local process.on is not available, try global process
        if (typeof process.on !== "function") {
          const globalProcess =
            (globalThis as any).process || (global as any).process;

          if (globalProcess && typeof globalProcess.on === "function") {
            processObj = globalProcess;
            logger.info(
              colors.green("✅ Using global process object for event handlers")
            );
          }
        }

        if (typeof processObj.on === "function") {
          try {
            processObj.on("SIGINT", () => gracefulShutdown("SIGINT"));
            processObj.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

            // Handle uncaught exceptions
            processObj.on("uncaughtException", (error) => {
              logger.error(colors.red(`❌ Uncaught Exception: ${error}`));
              gracefulShutdown("uncaughtException");
            });

            processObj.on("unhandledRejection", (reason, promise) => {
              logger.error(
                colors.red(
                  `❌ Unhandled Rejection at: ${promise}, reason: ${reason}`
                )
              );
              gracefulShutdown("unhandledRejection");
            });

            logger.info(
              colors.green("✅ Process event handlers registered successfully")
            );
          } catch (error) {
            logger.warn(
              colors.yellow(
                `⚠️  Failed to register process event handlers: ${error}`
              )
            );
          }
        } else {
          logger.warn(
            colors.yellow(
              "⚠️  process.on is not available, graceful shutdown handlers will not be registered"
            )
          );
          logger.info(
            colors.blue(
              "💡 This might be due to bundling or environment constraints"
            )
          );
        }
      });

      isRestarting = false;
    } catch (error) {
      isRestarting = false;
      logger.error(colors.red(`❌ Failed to start Next.js server: ${error}`));
      
      // Special handling for Next.js peer dependency errors
      if (
        error instanceof Error &&
        error.message.includes("Next.js is required")
      ) {
        logger.error(colors.red("❌ Next.js Peer Dependency Error:"));
        logger.error(colors.red(error.message));
        logger.error(colors.yellow("\n💡 To fix this issue:"));
        logger.error(colors.blue("   1. Install Next.js in your project:"));
        logger.error(colors.white("      npm install next@^15"));
        logger.error(colors.blue("   2. Or use yarn:"));
        logger.error(colors.white("      yarn add next@^15"));
        logger.error(colors.blue("   3. Or use pnpm:"));
        logger.error(colors.white("      pnpm add next@^15"));
        logger.error(colors.yellow("\n📖 For more information, see:"));
        logger.error(colors.blue("   https://nextjs.org/docs/getting-started"));
      }

      process.exit(1);
    }
  };

  // Handle graceful shutdown
  const gracefulShutdown = async (signal: string) => {
    logger.info(
      colors.yellow(
        `\n🛑 Received ${signal}, shutting down gracefully...`
      )
    );

    try {
      // Clean up config watcher
      if (configWatcher) {
        cleanupConfigWatcher(configWatcher);
        configWatcher = null;
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
      if (nextApp && typeof nextApp.close === "function") {
        await nextApp.close();
        nextApp = null;
      }

      logger.info(colors.green("✅ Graceful shutdown completed"));
      process.exit(0);
    } catch (error) {
      logger.error(colors.red(`❌ Error during graceful shutdown: ${error}`));
      process.exit(1);
    }
  };

  // Set up process signal handlers
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    logger.error(colors.red(`❌ Uncaught Exception: ${error}`));
    gracefulShutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason, promise) => {
    logger.error(
      colors.red(
        `❌ Unhandled Rejection at: ${promise}, reason: ${reason}`
      )
    );
    gracefulShutdown("unhandledRejection");
  });

  // Start the server
  await startNextServer();
  });

// build
cli
  .command("build [root]", "build for production")
  .option("--target <target>", `[string] transpile target (default: 'modules')`)
  .option("--outDir <dir>", `[string] output directory (default: dist)`)
  .option(
    "--assetsDir <dir>",
    `[string] directory under outDir to place assets in (default: assets)`
  )
  .option(
    "--assetsInlineLimit <number>",
    `[number] static asset base64 inline threshold in bytes (default: 4096)`
  )
  .option(
    "--ssr [entry]",
    `[string] build specified entry for server-side rendering`
  )
  .option(
    "--sourcemap [output]",
    `[boolean | "inline" | "hidden"] output source maps for build (default: false)`
  )
  .option(
    "--minify [minifier]",
    `[boolean | "terser" | "esbuild"] enable/disable minification, ` +
      `or specify minifier to use (default: esbuild)`
  )
  .option("--manifest [name]", `[boolean | string] emit build manifest json`)
  .option("--ssrManifest [name]", `[boolean | string] emit ssr manifest json`)
  .option(
    "--force",
    `[boolean] force the optimizer to ignore the cache and re-bundle (experimental)`
  )
  .option(
    "--emptyOutDir",
    `[boolean] force empty outDir when it's outside of root`
  )
  .option("-w, --watch", `[boolean] rebuilds when modules have changed on disk`)
  .option(
    "--changelog [assetsFile]",
    `[boolean | string] generate changelog between assetsFile and current build (default: false)`
  )
  .action(
    async (root: string, options: PPDevBuildOptions & GlobalCLIOptions) => {
      filterDuplicateOptions(options);
      const buildOptions: PPDevBuildOptions = cleanOptions(options);

      try {
        const configFromFile = await loadConfigFromFile(
          { mode: options.mode || "production", command: "build" },
          options.config,
          root,
          options.logLevel
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
          true
        ) as InlineConfig;

        await build(buildConfig);

        if (buildOptions.changelog) {
          const executionRoot = root || process.cwd();

          const outDir = buildConfig.build?.outDir || "dist";

          let oldAssetsPath = "";

          if (typeof buildOptions.changelog === "string") {
            oldAssetsPath = path.resolve(executionRoot, buildOptions.changelog);
          } else {
            const backupsDirPath = path.resolve(
              executionRoot,
              buildConfig.ppDevConfig?.syncBackupsDir || "backups"
            );

            if (!fs.existsSync(backupsDirPath)) {
              createLogger(options.logLevel).warn(
                colors.yellow(
                  `backups directory not found, skipping changelog generation`
                )
              );

              return;
            }

            const backups = fs.readdirSync(backupsDirPath, {
              withFileTypes: true,
            });

            if (!backups.length) {
              createLogger(options.logLevel).warn(
                colors.yellow(`no backups found, skipping changelog generation`)
              );

              return;
            }

            const latestBackup = backups
              .filter((value) => {
                return value.isFile() && value.name.endsWith(".zip");
              })
              .reduce((latest, current) => {
                const latestTime = fs.statSync(
                  path.resolve(backupsDirPath, latest.name)
                ).mtimeMs;
                const currentTime = fs.statSync(
                  path.resolve(backupsDirPath, current.name)
                ).mtimeMs;

                return latestTime > currentTime ? latest : current;
              }, backups[0]).name;

            oldAssetsPath = path.resolve(backupsDirPath, latestBackup);
          }

          const currentAssetFilePath = path.resolve(executionRoot, outDir);

          let changelogDestination = "dist-zip";

          if (buildConfig.ppDevConfig) {
            if (buildConfig.ppDevConfig.distZip === false) {
              changelogDestination =
                (buildConfig.build?.outDir as string) || "dist";
            } else if (
              typeof buildConfig.ppDevConfig.distZip === "object" &&
              typeof buildConfig.ppDevConfig.distZip.outDir === "string"
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
        createLogger(options.logLevel).error(
          colors.red(`error during build:\n${e.stack}`),
          { error: e }
        );

        process.exit(1);
      } finally {
        stopProfiler((message) => createLogger(options.logLevel).info(message));
      }
    }
  );

// changelog
cli
  .command(
    "changelog [oldAssetPath] [newAssetPath]",
    "generate changelog between two assets files/folders"
  )
  .option(
    "--oldAssetsPath <oldAssetsPath>",
    `[string] path to the old assets zip file or folder`
  )
  .option(
    "--newAssetsPath <newAssetsPath>",
    `[string] path to the new assets zip file or folder`
  )
  .option(
    "--destination <destination>",
    `[string] destination folder for the changelog (default: .)`
  )
  .option(
    "--filename <filename>",
    `[string] filename for the changelog (default: CHANGELOG.html)`
  )
  .action(
    async (
      oldAssetPath: string,
      newAssetPath: string,
      options: ChangelogOptions & GlobalCLIOptions
    ) => {
      filterDuplicateOptions(options);

      const {
        oldAssetsPath: oldPath = oldAssetPath,
        newAssetsPath: newPath = newAssetPath,
        destination = ".",
        filename = "CHANGELOG.html",
        logLevel,
      } = options;

      const root = process.cwd();

      if (!oldPath || !newPath) {
        createLogger(logLevel).error(
          colors.red(
            `error during changelog generation: oldAssetPath and newAssetPath are required`
          )
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
    }
  );

cli
  .command(
    "generate-icon-font [source] [destination]",
    "generate icon font from SVG files"
  )
  .option(
    "--source <source>",
    `[string] path to the source directory with SVG files`
  )
  .option(
    "--destination <destination>",
    `[string] path to the destination directory to save the generated font files`
  )
  .option(
    "--font-name, -n <fontName>",
    `[string] name of the font to generate (default: 'icon-font')`
  )
  .action(
    async (
      source: string,
      destination: string,
      options: IconFontOptions & GlobalCLIOptions
    ) => {
      filterDuplicateOptions(options);

      const {
        source: sourceDir = source,
        destination: destDir = destination,
        fontName = "icon-font",
      } = options;

      const root = process.cwd();

      const fullSourceDir = path.resolve(root, sourceDir);
      const fullDestDir = path.resolve(root, destDir);

      const iconFontGenerator = new IconFontGenerator({
        sourceDir: fullSourceDir,
        outputDir: fullDestDir,
        fontName,
      });

      const logger = createLogger(options.logLevel);

      logger.info(
        `Generating icon font from SVG files in ${colors.dim(fullSourceDir)}`
      );

      await iconFontGenerator.generate();

      logger.info(
        `Icon font generated and saved to ${colors.dim(fullDestDir)}`
      );
    }
  );

// optimize
cli
  .command("optimize [root]", "pre-bundle dependencies")
  .option(
    "--force",
    `[boolean] force the optimizer to ignore the cache and re-bundle`
  )
  .action(
    async (root: string, options: { force?: boolean } & GlobalCLIOptions) => {
      filterDuplicateOptions(options);
      try {
        const configFromFile = await loadConfigFromFile(
          { mode: options.mode || "production", command: "build" },
          options.config,
          root,
          options.logLevel
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
          "serve"
        );

        await optimizeDeps(optimizeConfig, options.force, true);
      } catch (e: any) {
        createLogger(options.logLevel).error(
          colors.red(`error when optimizing deps:\n${e.stack}`),
          { error: e }
        );

        process.exit(1);
      }
    }
  );

cli
  .command("preview [root]", "locally preview production build")
  .option("--host [host]", `[string] specify hostname`)
  .option("--port <port>", `[number] specify port`)
  .option("--strictPort", `[boolean] exit if specified port is already in use`)
  .option("--https", `[boolean] use TLS + HTTP/2`)
  .option("--open [path]", `[boolean | string] open browser on startup`)
  .option("--outDir <dir>", `[string] output directory (default: dist)`)
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
      } & GlobalCLIOptions
    ) => {
      filterDuplicateOptions(options);

      try {
        const configFromFile = await loadConfigFromFile(
          { mode: options.mode || "production", command: "build" },
          options.config,
          root,
          options.logLevel
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
          })
        );

        server.printUrls();
      } catch (e: any) {
        createLogger(options.logLevel).error(
          colors.red(`error when starting preview server:\n${e.stack}`),
          {
            error: e,
          }
        );

        process.exit(1);
      } finally {
        stopProfiler((message) => createLogger(options.logLevel).info(message));
      }
    }
  );

cli.help();
cli.version(VERSION);

cli.parse();
