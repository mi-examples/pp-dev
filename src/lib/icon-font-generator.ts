export interface IconFontGeneratorOptions {
  sourceDir: string;
  outputDir: string;
  fontName: string;
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
    const { default: svgToFont } = await import('svgtofont');

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
