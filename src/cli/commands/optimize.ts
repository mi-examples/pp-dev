import * as path from 'path';
import { getViteConfig } from '../../index.js';
import { mergeConfig, optimizeDeps, resolveConfig, loadConfigFromFile } from 'vite';
import { createLogger } from '../../lib/logger.js';
import { colors } from '../../lib/helpers/color.helper.js';
import { loadPPDevEnv } from '../../lib/env.js';
import type { CAC } from 'cac';
import { type GlobalCLIOptions, filterDuplicateOptions } from '../options.js';

export function registerOptimizeCommand(cli: CAC): void {
  cli
    .command('optimize [root]', 'pre-bundle dependencies')
    .option('--force', `[boolean] force the optimizer to ignore the cache and re-bundle`)
    .action(async (root: string, options: { force?: boolean } & GlobalCLIOptions) => {
      filterDuplicateOptions(options);
      try {
        const mode = options.mode || 'production';
        const envDir = path.resolve(process.cwd(), root ?? '.');

        loadPPDevEnv(mode, envDir);

        const configFromFile = await loadConfigFromFile(
          { mode, command: 'build' },
          options.config,
          root,
          options.logLevel,
        );

        let config = await getViteConfig(undefined, { mode, root: envDir });

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
}
