import * as path from 'path';
import * as fs from 'fs';
import { performance } from 'node:perf_hooks';
import { cac } from 'cac';
import { createColors } from 'picocolors';
import type { ServerOptions, BuildOptions, LogLevel } from 'vite';
import { VERSION } from './constants.js';
import { bindShortcuts } from './shortcuts.js';
import { getViteConfig } from './index.js';
import {
  mergeConfig,
  build,
  optimizeDeps,
  resolveConfig,
  preview,
  createLogger,
  ViteDevServer,
  loadConfigFromFile,
} from 'vite';

const cli = cac('pp-dev');
const colors = createColors();

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
    // output structure is preserved even after bundling so require()
    // is ok here
    const { createServer } = await import('vite');

    try {
      const configFromFile = await loadConfigFromFile(
        { mode: options.mode || 'development', command: 'serve' },
        options.config,
        root,
        options.logLevel,
      );

      let config = await getViteConfig();

      if (configFromFile) {
        const { plugins, ...fileConfig } = configFromFile.config;

        config = mergeConfig(config, fileConfig);
      }

      const server = await createServer(
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
          },
          true,
        ),
      );

      if (!server.httpServer) {
        throw new Error('HTTP server not available');
      }

      await server.listen();

      const info = server.config.logger.info;

      const ppDevStartTime = (global as any).__pp_dev_start_time ?? false;
      const startupDurationString = ppDevStartTime
        ? colors.dim(`ready in ${colors.reset(colors.bold(Math.ceil(performance.now() - ppDevStartTime)))} ms`)
        : '';

      info(`\n  ${colors.green(`${colors.bold('PP-DEV')} v${VERSION}`)}  ${startupDurationString}\n`, {
        clear: !server.config.logger.hasWarned,
      });

      server.printUrls();
      bindShortcuts(server, {
        print: true,
        customShortcuts: [
          profileSession && {
            key: 'p',
            description: 'start/stop the profiler',
            async action(server) {
              if (profileSession) {
                await stopProfiler(server.config.logger.info);
              } else {
                const inspector = await import('node:inspector').then((r) => (r as any).default);
                await new Promise<void>((res) => {
                  profileSession = new inspector.Session();
                  profileSession.connect();
                  profileSession.post('Profiler.enable', () => {
                    profileSession?.post('Profiler.start', () => {
                      server.config.logger.info('Profiler started');
                      res();
                    });
                  });
                });
              }
            },
          },
          {
            key: 'l',
            description: 'proxy re-login',
            action(server: ViteDevServer): void | Promise<void> {
              server.ws.send({
                type: 'custom',
                event: 'redirect',
                data: { url: `/auth/index/logout?proxyRedirect=${encodeURIComponent('/')}` },
              });
            },
          },
        ],
      });
    } catch (e: any) {
      const logger = createLogger(options.logLevel);

      logger.error(colors.red(`error when starting dev server:\n${e.stack}`), {
        error: e,
      });
      stopProfiler(logger.info);

      process.exit(1);
    }
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
  .action(async (root: string, options: BuildOptions & GlobalCLIOptions) => {
    filterDuplicateOptions(options);
    const buildOptions: BuildOptions = cleanOptions(options);

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

      await build(
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
            build: buildOptions,
          },
          true,
        ),
      );
    } catch (e: any) {
      createLogger(options.logLevel).error(colors.red(`error during build:\n${e.stack}`), { error: e });

      process.exit(1);
    } finally {
      stopProfiler((message) => createLogger(options.logLevel).info(message));
    }
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

cli.help();
cli.version(VERSION);

cli.parse();
