import svgToFont from 'svgtofont';

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
