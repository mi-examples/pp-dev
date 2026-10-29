import { mergeConfig, preview } from 'vite';
import { createLogger } from '../../lib/logger.js';
import { colors } from '../../lib/helpers/color.helper.js';
import type { CAC } from 'cac';
import { type GlobalCLIOptions, filterDuplicateOptions } from '../options.js';
import { loadCommandViteConfig } from '../vite-config.js';
import { stopProfiler } from '../profiler.js';

export function registerPreviewCommand(cli: CAC): void {
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
          const mode = options.mode || 'production';
          const { config } = await loadCommandViteConfig({
            root,
            mode,
            command: 'build',
            configFile: options.config,
            logLevel: options.logLevel,
          });

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
}
