// Type only: the package is loaded on use, in `loadSvgToFont()`.
import type svgToFont from 'svgtofont';

export interface IconFontGeneratorOptions {
  sourceDir: string;
  outputDir: string;
  fontName: string;
}

type SvgToFont = typeof svgToFont;

/** Thrown when `svgtofont`, an optional peer dependency, is not installed in the project. */
export class SvgToFontMissingError extends Error {
  constructor(cause: unknown) {
    super(
      `Icon font generation needs the "svgtofont" package, which is not installed with pp-dev.\n` +
        `Add it to your project and run the command again:\n` +
        `  npm install --save-dev svgtofont`,
      { cause },
    );
    this.name = 'SvgToFontMissingError';
  }
}

/**
 * True when the import failed because `svgtofont` itself is absent. A package that svgtofont
 * depends on can be missing too, and its error names `svgtofont` only in the importing file's path.
 */
function isSvgToFontMissing(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };

  return (
    (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') &&
    typeof message === 'string' &&
    /Cannot find (?:package|module) ["']svgtofont["']/.test(message)
  );
}

/**
 * Loads `svgtofont`. It is an optional peer dependency: only `pp-dev generate-icon-font` uses it,
 * and as a dependency it brought its own dependency tree into every project that installs pp-dev.
 */
export async function loadSvgToFont(
  importSvgToFont: () => Promise<{ default: SvgToFont }> = () => import('svgtofont'),
): Promise<SvgToFont> {
  try {
    return (await importSvgToFont()).default;
  } catch (error) {
    throw isSvgToFontMissing(error) ? new SvgToFontMissingError(error) : error;
  }
}

export class IconFontGenerator {
  private readonly sourceDir: string;
  private readonly outputDir: string;
  private readonly fontName: string;

  constructor(options: IconFontGeneratorOptions) {
    this.sourceDir = options.sourceDir;
    this.outputDir = options.outputDir;
    this.fontName = options.fontName;
  }

  public async generate(): Promise<void> {
    // Loaded here, not with the module: the CLI imports this class for one command, and svgtofont
    // takes about a second to load for all the others (`--version` included).
    const svgToFont = await loadSvgToFont();

    await svgToFont({
      src: this.sourceDir,
      dist: this.outputDir,
      fontName: this.fontName,
      css: true,
      typescript: true,
      startUnicode: 0xea01,
      svgicons2svgfont: {
        fontHeight: 1024,
      },
    });
  }
}
