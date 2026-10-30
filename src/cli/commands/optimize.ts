import { mergeConfig, optimizeDeps, resolveConfig } from 'vite';
import { createLogger } from '../../lib/logger.js';
import { colors } from '../../lib/helpers/color.helper.js';
import type { CAC } from 'cac';
import { type GlobalCLIOptions, filterDuplicateOptions } from '../options.js';
import { loadCommandViteConfig } from '../vite-config.js';

export function registerOptimizeCommand(cli: CAC): void {
  cli
    .command('optimize [root]', 'pre-bundle dependencies')
    .option('--force', `[boolean] force the optimizer to ignore the cache and re-bundle`)
    .action(async (root: string, options: { force?: boolean } & GlobalCLIOptions) => {
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
}
