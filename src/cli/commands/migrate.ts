import * as path from 'path';
import * as fs from 'fs';
import { createLogger } from '../../lib/logger.js';
import { colors } from '../../lib/helpers/color.helper.js';
import type { CAC } from 'cac';
import { type GlobalCLIOptions } from '../options.js';

export function registerMigrateCommand(cli: CAC): void {
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
          discoverMigrateSource,
          loadPackageJsonMigrateConfig,
        } = await import('../../lib/migrate.js');

        const format = (options.format ?? 'ts') as 'ts' | 'js' | 'json';
        const doBackup = options.backup !== false;
        const projectRoot = process.cwd();

        // Discover config file to migrate
        const migrateSource = discoverMigrateSource(projectRoot, configArg);

        if (!migrateSource) {
          logger.warn(colors.yellow('No pp-dev or pp-watch config file found in the current directory.'));
          logger.info(
            colors.blue(
              'Supported files: pp-dev.config.{ts,js,cjs,mjs,json}, .pp-watch.config.{ts,js,json}, or a "pp-dev" field in package.json',
            ),
          );
          process.exit(1);
        }

        const { sourceFile, isWatchConfig, isPackageJsonConfig } = migrateSource;

        logger.info(colors.blue(`Found config: ${path.relative(projectRoot, sourceFile)}`));

        // Load the config
        const { getConfig, getPkg } = await import('../../config.js');
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
              target: 'node24',
              platform: 'node',
              bundle: true,
              packages: 'external',
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
              if (fs.existsSync(tmpFile)) {
                fs.unlinkSync(tmpFile);
              }
            }
          } else if (/\.[cm]?js$/i.test(sourceFile)) {
            const { pathToFileURL } = await import('url');
            const mod = await import(pathToFileURL(path.resolve(projectRoot, sourceFile)).toString());

            rawConfig = mod.default?.default ?? mod.default ?? mod;
          } else if (isPackageJsonConfig) {
            rawConfig = loadPackageJsonMigrateConfig(sourceFile) as Record<string, unknown>;
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
          logger.info(
            colors.green(`\n--- Migrated config (dry-run) → ${path.relative(projectRoot, outputFile)} ---\n`),
          );
          console.log(outputContent);
          process.exit(0);
        }

        // Backup original
        if (doBackup && !isPackageJsonConfig && fs.existsSync(sourceFile)) {
          const backupPath = `${sourceFile}.bak`;

          fs.copyFileSync(sourceFile, backupPath);
          logger.info(colors.blue(`Backed up original to: ${path.relative(projectRoot, backupPath)}`));
        }

        fs.writeFileSync(outputFile, outputContent, 'utf-8');
        logger.info(colors.green(`✅ Migration complete → ${path.relative(projectRoot, outputFile)}`));

        if (isPackageJsonConfig) {
          logger.info(colors.yellow('You can now remove the "pp-dev" field from package.json.'));
        } else if (sourceFile !== outputFile && fs.existsSync(sourceFile)) {
          logger.info(colors.yellow(`You can now delete the old config: ${path.relative(projectRoot, sourceFile)}`));
        }
      },
    );
}
