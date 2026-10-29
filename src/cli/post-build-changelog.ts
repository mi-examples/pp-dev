import * as path from 'path';
import * as fs from 'fs';
import { LogLevel } from 'vite';
import { createLogger } from '../lib/logger.js';
import { colors } from '../lib/helpers/color.helper.js';
import { ChangelogGenerator } from '../lib/changelog-generator.js';

export interface ChangelogOptions {
  oldAssetsPath?: string;
  newAssetsPath?: string;
  destination?: string;
  filename?: string;
}

export interface PostBuildChangelogOptions {
  changelog: boolean | string;
  executionRoot: string;
  newAssetsPath: string;
  backupsDirPath: string;
  changelogDestinationPath: string;
  logLevel?: LogLevel;
}

/**
 * Shared by `build` (Vite) and `next-build` (Next.js): diff the current build output
 * against the latest backup ZIP (or an explicitly given assets file) and write a changelog.
 */
export async function generatePostBuildChangelog(opts: PostBuildChangelogOptions): Promise<void> {
  const { changelog, executionRoot, newAssetsPath, backupsDirPath, changelogDestinationPath, logLevel } = opts;

  let oldAssetsPath: string;

  if (typeof changelog === 'string') {
    oldAssetsPath = path.resolve(executionRoot, changelog);
  } else {
    if (!fs.existsSync(backupsDirPath)) {
      createLogger(logLevel).warn(colors.yellow(`backups directory not found, skipping changelog generation`));

      return;
    }

    const backups = fs.readdirSync(backupsDirPath, { withFileTypes: true });

    if (!backups.length) {
      createLogger(logLevel).warn(colors.yellow(`no backups found, skipping changelog generation`));

      return;
    }

    const zipBackups = backups.filter((value) => value.isFile() && value.name.endsWith('.zip'));

    if (!zipBackups.length) {
      createLogger(logLevel).warn(colors.yellow(`no ZIP backups found, skipping changelog generation`));

      return;
    }

    const latestBackup = zipBackups.reduce((latest, current) => {
      const latestTime = fs.statSync(path.resolve(backupsDirPath, latest.name)).mtimeMs;
      const currentTime = fs.statSync(path.resolve(backupsDirPath, current.name)).mtimeMs;

      return latestTime > currentTime ? latest : current;
    }).name;

    oldAssetsPath = path.resolve(backupsDirPath, latestBackup);
  }

  const changelogGenerator = new ChangelogGenerator({
    oldAssetsPath,
    newAssetsPath,
    destinationPath: changelogDestinationPath,
  });

  await changelogGenerator.generateChangelog();
}
