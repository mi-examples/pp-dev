import * as path from 'path';
import { createLogger } from '../../lib/logger.js';
import { colors } from '../../lib/helpers/color.helper.js';
import { ChangelogGenerator } from '../../lib/changelog-generator.js';
import type { CAC } from 'cac';
import { type GlobalCLIOptions, filterDuplicateOptions } from '../options.js';
import { type ChangelogOptions } from '../post-build-changelog.js';

export function registerChangelogCommand(cli: CAC): void {
  cli
    .command('changelog [oldAssetPath] [newAssetPath]', 'generate changelog between two assets files/folders')
    .option('--oldAssetsPath <oldAssetsPath>', `[string] path to the old assets zip file or folder`)
    .option('--newAssetsPath <newAssetsPath>', `[string] path to the new assets zip file or folder`)
    .option('--destination <destination>', `[string] destination folder for the changelog (default: .)`)
    .option('--filename <filename>', `[string] filename for the changelog (default: CHANGELOG.html)`)
    .action(async (oldAssetPath: string, newAssetPath: string, options: ChangelogOptions & GlobalCLIOptions) => {
      filterDuplicateOptions(options);

      const {
        oldAssetsPath: oldPath = oldAssetPath,
        newAssetsPath: newPath = newAssetPath,
        destination = '.',
        filename = 'CHANGELOG.html',
        logLevel,
      } = options;

      const root = process.cwd();

      if (!oldPath || !newPath) {
        createLogger(logLevel).error(
          colors.red(`error during changelog generation: oldAssetPath and newAssetPath are required`),
        );

        process.exit(1);
      }

      const fullOldPath = path.resolve(root, oldPath);
      const fullNewPath = path.resolve(root, newPath);
      const fullDestination = path.resolve(root, destination);

      const changelogGenerator = new ChangelogGenerator({
        oldAssetsPath: fullOldPath,
        newAssetsPath: fullNewPath,
        destinationPath: fullDestination,
        changelogFilename: filename,
      });

      await changelogGenerator.generateChangelog();
    });
}
