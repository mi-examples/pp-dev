import * as path from 'path';
import { performance } from 'node:perf_hooks';
import { ServerOptions } from 'vite';
import { VERSION } from '../../constants.js';
import { bindShortcuts } from '../../shortcuts.js';
import { getViteConfig } from '../../index.js';
import { mergeConfig, ViteDevServer, loadConfigFromFile } from 'vite';
import { createLogger } from '../../lib/logger.js';
import { colors } from '../../lib/helpers/color.helper.js';
import { registerProcessHandlers } from '../../lib/process-handlers.js';
import { INSPECTOR_PATH } from '../../lib/request-inspector.js';
import { loadPPDevEnv } from '../../lib/env.js';
import { cleanOptions } from '../../lib/cli-options.js';
import type { CAC } from 'cac';
import { createConfigWatcher, cleanupConfigWatcher, type ConfigWatcher } from '../config-watcher.js';
import { type GlobalCLIOptions, filterDuplicateOptions } from '../options.js';
import { stopProfiler, profilerShortcuts } from '../profiler.js';

export function registerServeCommand(cli: CAC): void {
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
        if (isRestarting) {
          return;
        }

        isRestarting = true;

        try {
          // Clean up existing server if any
          if (server) {
            logger.info(colors.yellow('🛑 Stopping existing dev server...'));
            await server.close();
            server = null;
          }

          // Clear config cache
          const { clearConfigCache, getConfig } = await import('../../config.js');

          clearConfigCache();

          // output structure is preserved even after bundling so require()
          // is ok here
          const { createServer } = await import('vite');
          const mode = options.mode || 'development';
          const envDir = path.resolve(process.cwd(), root ?? '.');

          loadPPDevEnv(mode, envDir);

          const configFromFile = await loadConfigFromFile(
            { mode, command: 'serve' },
            options.config,
            root,
            options.logLevel,
          );

          let config = await getViteConfig(undefined, { mode, root: envDir });

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

          const serveConfig = await getConfig(envDir);

          if (serveConfig.inspector?.enabled !== false) {
            const localUrl = server.resolvedUrls?.local[0];
            const origin = localUrl
              ? new URL(localUrl).origin
              : `http://localhost:${server.config.server.port ?? 5173}`;

            logger.info(`\n  ${colors.cyan('🔍 Request Inspector')}  ${colors.dim(origin + INSPECTOR_PATH)}\n`);
          }

          bindShortcuts(server, {
            print: true,
            customShortcuts: [
              ...profilerShortcuts(logger.info),
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

      registerProcessHandlers({
        logger,
        shutdown: async () => {
          if (configWatcher) {
            cleanupConfigWatcher(configWatcher);
            configWatcher = null;
          }

          if (server) {
            await server.close();
            server = null;
          }

          stopProfiler(logger.info);
        },
      });

      // Start the server
      await startServer();
    });
}
