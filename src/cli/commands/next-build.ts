import * as path from 'path';
import * as fs from 'fs';
import { createLogger } from '../../lib/logger.js';
import { colors } from '../../lib/helpers/color.helper.js';
import { safeNextImport } from '../../lib/next-import.js';
import { PP_DEV_NEXT_BUILD_ENV_VAR } from '../../constants.js';
import { normalizePPDevConfig } from '../../lib/pp-dev-config.js';
import {
  resolveBuildCliOverrides,
  applyDistZipOverride,
  applyVersionManifestOverride,
  BuildOverrideCLIOptions,
} from '../../lib/build-cli-overrides.js';
import { writeBuildVersionManifest } from '../../lib/version-manifest.js';
import { zipDirectoryToBuffer } from '../../lib/helpers/zip.helper.js';
import { runNextBuildProcess, removeStaleDevTypes } from '../../lib/next-build-runner.js';
import { createDefaultZipFileName, resolveOutputFilePath } from '../../lib/output-path.js';
import { loadPPDevEnv } from '../../lib/env.js';
import type { CAC } from 'cac';
import { type GlobalCLIOptions, filterDuplicateOptions } from '../options.js';
import { generatePostBuildChangelog } from '../post-build-changelog.js';
import { stopProfiler } from '../profiler.js';

export function registerNextBuildCommand(cli: CAC): void {
  cli
    .command(
      'next-build [root]',
      'build a Next.js app for production (`next build`) and emit VERSION/BUILD-MANIFEST/zip in the same format as `pp-dev build`',
    )
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
    .action(
      async (root: string, options: { changelog?: boolean | string } & BuildOverrideCLIOptions & GlobalCLIOptions) => {
        filterDuplicateOptions(options);

        const logger = createLogger(options.logLevel);
        const projectRoot = root ? path.resolve(process.cwd(), root) : process.cwd();
        const cliOverrides = resolveBuildCliOverrides(options);

        // Also covers the `loadConfig()` call below, which evaluates the Next.js config (and thus
        // `withPPDev()`) in this process before `runNextBuildProcess()` spawns the actual `next build`.
        process.env[PP_DEV_NEXT_BUILD_ENV_VAR] = '1';

        try {
          loadPPDevEnv(options.mode || 'production', projectRoot);

          const { constants } = await safeNextImport();

          const importConfig = await import('next/dist/server/config.js');

          const loadConfig: typeof import('next/dist/server/config.js').default =
            (importConfig as any).default.default ||
            (importConfig as any)['module.exports'].default ||
            (importConfig as any).default;

          const nextConfig = await loadConfig(constants.PHASE_PRODUCTION_BUILD, projectRoot);

          // Resolve pp-dev config: prefer `ppDev` on the Next.js config, else standalone pp-dev config file
          let ppDevConfig = nextConfig?.ppDev || {};

          if (Object.keys(ppDevConfig).length === 0) {
            const { getConfig } = await import('../../config.js');

            ppDevConfig = await getConfig(projectRoot);
          }

          const { getPkg } = await import('../../config.js');
          const normalized = normalizePPDevConfig(ppDevConfig, getPkg(projectRoot).name);
          const distZip = applyDistZipOverride(
            normalized.distZip,
            cliOverrides,
            createDefaultZipFileName(normalized.templateName),
          );
          const versionPlugin = applyVersionManifestOverride(normalized.versionPlugin, cliOverrides);

          const removedDevTypes = removeStaleDevTypes(projectRoot, nextConfig);

          if (removedDevTypes) {
            logger.info(
              colors.dim(`[pp-dev] Removed stale dev route types: ${path.relative(projectRoot, removedDevTypes)}`),
            );
          }

          logger.info(colors.cyan('[pp-dev] Running `next build`...'));

          await runNextBuildProcess(projectRoot);

          // With `output: 'export'`, the static export lands in distDir (or `out` when distDir is the '.next' default).
          const rawDistDir =
            typeof nextConfig?.distDir === 'string' && nextConfig.distDir ? nextConfig.distDir : '.next';
          const exportDirName = rawDistDir === '.next' ? 'out' : rawDistDir;
          const outDir = path.resolve(projectRoot, exportDirName);

          if (!fs.existsSync(outDir) || !fs.statSync(outDir).isDirectory()) {
            throw new Error(
              `Next.js build output directory not found: ${outDir}. ` +
                `"next-build" requires "output: 'export'" in next.config (static export).`,
            );
          }

          const projectPkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));

          if (versionPlugin !== false && versionPlugin.enabled !== false) {
            await writeBuildVersionManifest({
              outDir,
              packageVersion: typeof projectPkg.version === 'string' ? projectPkg.version : '0.0.0',
              versionFileTemplate: versionPlugin.versionFileTemplate,
              packageRepositoryUrl:
                typeof projectPkg.repository === 'string' ? projectPkg.repository : projectPkg.repository?.url,
              enabled: versionPlugin.enabled,
            });

            logger.info(colors.green(`✅ VERSION / BUILD-MANIFEST written to ${path.relative(projectRoot, outDir)}`));
          }

          if (distZip !== false) {
            const zipOutDir = path.resolve(projectRoot, distZip.outDir);
            const zipSourceDir = distZip.inDir ? path.resolve(outDir, distZip.inDir) : outDir;
            const zipFile = resolveOutputFilePath(zipOutDir, distZip.outFileName, 'ZIP output file name');

            fs.mkdirSync(path.dirname(zipFile), { recursive: true });

            const buffer = await zipDirectoryToBuffer(zipSourceDir);

            fs.writeFileSync(zipFile, buffer);

            logger.info(colors.green(`✅ Zip archive written to ${path.relative(projectRoot, zipFile)}`));
          }

          if (options.changelog) {
            const changelogDestination = distZip !== false ? distZip.outDir : exportDirName;

            await generatePostBuildChangelog({
              changelog: options.changelog,
              executionRoot: projectRoot,
              newAssetsPath: outDir,
              backupsDirPath: path.resolve(projectRoot, normalized.syncBackupsDir),
              changelogDestinationPath: path.resolve(projectRoot, changelogDestination),
              logLevel: options.logLevel,
            });
          }
        } catch (e: any) {
          createLogger(options.logLevel).error(colors.red(`error during next-build:\n${e.stack}`), { error: e });

          process.exit(1);
        } finally {
          stopProfiler((message) => createLogger(options.logLevel).info(message));
        }
      },
    );
}
