import * as path from 'path';
import { createLogger } from '../../lib/logger.js';
import { colors } from '../../lib/helpers/color.helper.js';
import { IconFontGenerator } from '../../lib/icon-font-generator.js';
import type { CAC } from 'cac';
import { type GlobalCLIOptions, filterDuplicateOptions } from '../options.js';

interface IconFontOptions {
  source?: string;
  destination?: string;
  fontName?: string;
}

export function registerGenerateIconFontCommand(cli: CAC): void {
  cli
    .command('generate-icon-font [source] [destination]', 'generate icon font from SVG files')
    .option('--source <source>', `[string] path to the source directory with SVG files`)
    .option(
      '--destination <destination>',
      `[string] path to the destination directory to save the generated font files`,
    )
    .option('--font-name, -n <fontName>', `[string] name of the font to generate (default: 'icon-font')`)
    .action(async (source: string, destination: string, options: IconFontOptions & GlobalCLIOptions) => {
      filterDuplicateOptions(options);

      const { source: sourceDir = source, destination: destDir = destination, fontName = 'icon-font' } = options;

      const root = process.cwd();

      const fullSourceDir = path.resolve(root, sourceDir);
      const fullDestDir = path.resolve(root, destDir);

      const iconFontGenerator = new IconFontGenerator({
        sourceDir: fullSourceDir,
        outputDir: fullDestDir,
        fontName,
      });

      const logger = createLogger(options.logLevel);

      logger.info(`Generating icon font from SVG files in ${colors.dim(fullSourceDir)}`);

      await iconFontGenerator.generate();

      logger.info(`Icon font generated and saved to ${colors.dim(fullDestDir)}`);
    });
}
