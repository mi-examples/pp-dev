import * as path from 'path';
import { performance } from 'node:perf_hooks';
import { type ServerOptions } from 'vite';
import { VERSION } from '../../constants.js';
import { bindShortcuts } from '../../shortcuts.js';
import { mergeConfig, type ViteDevServer } from 'vite';
import { createLogger } from '../../lib/logger.js';
import { colors } from '../../lib/helpers/color.helper.js';
import { registerProcessHandlers } from '../../lib/process-handlers.js';
import { INSPECTOR_PATH } from '../../lib/request-inspector.js';
import { cleanOptions } from '../../lib/cli-options.js';
import type { CAC } from 'cac';
import { createConfigWatcher, cleanupConfigWatcher, type ConfigWatcher } from '../config-watcher.js';
import { type GlobalCLIOptions, filterDuplicateOptions } from '../options.js';
import { loadCommandViteConfig } from '../vite-config.js';
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

      const projectRoot = root ? path.resolve(process.cwd(), root) : process.cwd();
      const logger = createLogger(options.logLevel);

      /**
       * Starts the dev server. On a restart the new server is created, its config loaded and
       * checked, before the running one is stopped: a config that can't be loaded (half-written, a
       * typo in `app.id`, a broken `.env` line) leaves the running server, with its session, as it
       * is, instead of ending the process with it.
       */
      const startServer = async ({ restart = false } = {}) => {
        let nextServer: ViteDevServer | null = null;

        try {
          // Clear config cache
          const { clearConfigCache, getConfig } = await import('../../config.js');

          clearConfigCache();

          // output structure is preserved even after bundling so require()
          // is ok here
          const { createServer } = await import('vite');
          const mode = options.mode || 'development';
          const { config, envDir } = await loadCommandViteConfig({
            root,
            mode,
            command: 'serve',
            configFile: options.config,
            logLevel: options.logLevel,
          });

          nextServer = await createServer(
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

          if (!nextServer.config.base || nextServer.config.base === '/') {
            throw new Error('base cannot be equal to "/" or empty string');
          }

          if (!nextServer.httpServer) {
            throw new Error('HTTP server not available');
          }

          // Stop the running server, if any, now that the new one is ready to listen
          if (server) {
            const previous = server;

            server = null;
            logger.info(colors.yellow('🛑 Stopping existing dev server...'));
            await previous.close();
          }

          await nextServer.listen();
          server = nextServer;

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
            configWatcher = createConfigWatcher(projectRoot, () => startServer({ restart: true }), logger.info);
          }
        } catch (e: any) {
          if (!restart) {
            logger.error(colors.red(`error when starting dev server:\n${e.stack}`), {
              error: e,
            });
            stopProfiler(logger.info);
            process.exit(1);

            return;
          }

          // Created but never listened: let go of what it opened.
          if (nextServer && nextServer !== server) {
            await nextServer.close().catch(() => undefined);
          }

          logger.error(colors.red(`❌ Failed to restart dev server:\n${e.stack}`), { error: e });
          logger.warn(
            colors.yellow(
              server
                ? '⚠️  The running dev server is kept, with its config, until the next config change'
                : '⚠️  No dev server is running; it starts again on the next config change',
            ),
          );
        }
      };

      registerProcessHandlers({
        logger,
        shutdown: async () => {
          if (configWatcher) {
            await cleanupConfigWatcher(configWatcher);
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
