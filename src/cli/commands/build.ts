import * as path from 'path';
import { BuildOptions, InlineConfig } from 'vite';
import { getViteConfig } from '../../index.js';
import { mergeConfig, build, loadConfigFromFile } from 'vite';
import { createLogger } from '../../lib/logger.js';
import { colors } from '../../lib/helpers/color.helper.js';
import { resolveBuildCliOverrides, BuildOverrideCLIOptions } from '../../lib/build-cli-overrides.js';
import { loadPPDevEnv } from '../../lib/env.js';
import { cleanOptions } from '../../lib/cli-options.js';
import type { CAC } from 'cac';
import { type PPDevBuildOptions, type GlobalCLIOptions, filterDuplicateOptions } from '../options.js';
import { generatePostBuildChangelog } from '../post-build-changelog.js';
import { stopProfiler } from '../profiler.js';

export function registerBuildCommand(cli: CAC): void {
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
      `[boolean | "terser" | "esbuild"] enable/disable minification, ` +
        `or specify minifier to use (default: esbuild)`,
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
    .option(
      '--distZip',
      `[boolean] pack build output into a ZIP archive; use --no-distZip to disable (default: pp-dev config build.zip, or true). Env: PP_DEV_DIST_ZIP`,
    )
    .option(
      '--distZipDir <dir>',
      `[string] override the ZIP output directory (default: 'dist-zip'). Env: PP_DEV_DIST_ZIP_DIR`,
    )
    .option(
      '--distZipFilename <filename>',
      `[string] override the ZIP output file name (default: '<app-name>.zip'). Env: PP_DEV_DIST_ZIP_FILENAME`,
    )
    .option(
      '--versionManifest',
      `[boolean] emit VERSION-*.json + BUILD-MANIFEST.json; use --no-versionManifest to disable (default: pp-dev config build.versionFile, or true). Env: PP_DEV_VERSION_MANIFEST`,
    )
    .option(
      '--versionFileTemplate <template>',
      `[string] override the VERSION file name template (default: 'VERSION-v{packageversion}-{currentDate}.json'). Env: PP_DEV_VERSION_FILE_TEMPLATE`,
    )
    .action(async (root: string, options: PPDevBuildOptions & BuildOverrideCLIOptions & GlobalCLIOptions) => {
      filterDuplicateOptions(options);

      // Vite build options only: pp-dev's own flags (--changelog, --distZip…) are read from `options`.
      const buildOptions: BuildOptions = cleanOptions(options);
      const cliOverrides = resolveBuildCliOverrides(options);

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

        let config = await getViteConfig(cliOverrides, { mode, root: envDir });

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

        if (options.changelog) {
          const executionRoot = root || process.cwd();
          const outDir = (buildConfig.build?.outDir as string) || 'dist';

          let changelogDestination = 'dist-zip';

          if (buildConfig.ppDevConfig) {
            if (buildConfig.ppDevConfig.distZip === false) {
              changelogDestination = outDir;
            } else if (
              typeof buildConfig.ppDevConfig.distZip === 'object' &&
              typeof buildConfig.ppDevConfig.distZip.outDir === 'string'
            ) {
              changelogDestination = buildConfig.ppDevConfig.distZip.outDir;
            }
          }

          await generatePostBuildChangelog({
            changelog: options.changelog,
            executionRoot,
            newAssetsPath: path.resolve(executionRoot, outDir),
            backupsDirPath: path.resolve(executionRoot, buildConfig.ppDevConfig?.syncBackupsDir || 'backups'),
            changelogDestinationPath: path.resolve(executionRoot, changelogDestination),
            logLevel: options.logLevel,
          });
        }
      } catch (e: any) {
        createLogger(options.logLevel).error(colors.red(`error during build:\n${e.stack}`), { error: e });

        process.exit(1);
      } finally {
        stopProfiler((message) => createLogger(options.logLevel).info(message));
      }
    });
}
