import * as dirCompare from 'dir-compare';
import * as path from 'path';
import DiffMatchPatch from 'diff-match-patch';
import { isBinaryFile } from 'isbinaryfile';
import * as fs from 'fs';
import { createLogger } from './logger.js';
import { colors } from './helpers/color.helper';
import * as os from 'os';
import * as crypto from 'crypto';
import extractZip from 'extract-zip';

export const changelogTemplate = /* HTML */ `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <title>Changelog Diff</title>
      <style>
        tr,
        td {
          padding: 0;
        }
        .diff-file {
          margin-top: 20px;
          border: 1px solid #e1e4e8;
          border-radius: 6px;
        }
        .diff-file-title {
          padding: 10px 20px;
          background-color: #f6f8fa;
          border-bottom: 1px solid #e1e4e8;
          border-radius: 6px 6px 0 0;
          font-weight: bold;
        }
        .diff-file-title .renamed {
          font-weight: normal;
        }
        .diff-file-title .renamed .from {
          color: #cb2431;
        }
        .diff-file-title .renamed .to {
          color: #22863a;
        }
        .diff-file-title .added {
          color: #22863a;
        }
        .diff-file-title .deleted {
          color: #cb2431;
        }
        .diff-file-content {
        }
        .diff-table {
          tab-size: 8;
          width: 100%;
          border-collapse: separate;
          border-spacing: 0;
        }
        .blob-num {
          position: relative;
          color: #1f2328;
          width: 1%;
          min-width: 50px;
          padding: 0 10px;
          font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
          font-size: 12px;
          line-height: 20px;
          text-align: right;
          white-space: nowrap;
          vertical-align: top;
          cursor: pointer;
          -webkit-user-select: none;
          user-select: none;
        }
        .blob-num.addition {
          background-color: #ccffd8;
          border-color: #1f883e;
        }
        .blob-num.deletion {
          background-color: #ffd7d5;
          border-color: #cf222e;
        }
        .blob-num::before {
          content: attr(data-line-number);
        }
        .blob-code {
          position: relative;
          padding: 0 10px 0 22px;
          vertical-align: top;
          color: #1f2329;
        }
        .blob-code.code-addition {
          background-color: #e6ffec;
        }
        .blob-code.code-deletion {
          background-color: #ffebe9;
        }
        .blob-code.skip,
        .blob-code.message {
          text-align: center;
        }
        .blob-code.skip .blob-code-inner,
        .blob-code.message .blob-code-inner {
          font-weight: bold;
          color: #6a737d;
          padding: 10px 0;
        }
        .blob-code-inner {
          display: table-cell;
          overflow: visible;
          font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
          font-size: 12px;
          word-wrap: anywhere;
          white-space: pre-wrap;
        }
        .blob-code-inner::before {
          content: attr(data-code-prefix);
          position: absolute;
          top: 1px;
          left: 8px;
          padding-right: 8px;
        }
      </style>
    </head>
    <body>
      <h1>Changelog Diff</h1>

      %FILES%
    </body>
  </html>`;

export interface ChangelogGeneratorOptions {
  /**
   * Path to the previous assets folder or zip file
   */
  oldAssetsPath: string;

  /**
   * Path to the current assets folder or zip file
   */
  newAssetsPath: string;

  /**
   * Path to the destination folder where the changelog file will be written
   * @default ./dist-zip
   */
  destinationPath: string;

  /**
   * Filename for the changelog file
   * @default CHANGELOG.html
   */
  changelogFilename?: string;

  /**
   * Custom changelog template
   */
  changelogTemplate?: string;

  /**
   * Custom diff file template handler
   */
  diffFileTemplateHandler?: (filename: string, htmlDiff: string) => string;

  /**
   * Custom diff line template handler
   */
  diffLineTemplateHandler?: (diffLine: ChangelogDiffLine) => string;

  /**
   * Number of context lines to show before and after the diff
   * @default 3
   */
  contextLines?: number;
}

export const LINE_ADDED = 1;
export const LINE_REMOVED = -1;
export const LINE_CONTEXT = 0;

export type ChangelogLineType = typeof LINE_ADDED | typeof LINE_REMOVED | typeof LINE_CONTEXT;

export interface ChangelogDiffLine {
  /**
   * Line number
   */
  lineNumber: number;

  /**
   * Line content
   */
  lineContent: string;

  /**
   * Line type
   */
  lineType: ChangelogLineType;
}

/**
 * Escape HTML sequence
 * @param str
 */
export function escapeHTMLSequence(str: string): string {
  return str.replace(/[\u00A0-\u9999<>&]/g, (i) => '&#' + i.charCodeAt(0) + ';');
}

const fileNameWithHashRegEx = /(.+)(-[a-f0-9]{6,20})(\.[a-z0-9]+)$/i;

/**
 * Changelog generator class
 * @class
 * @classdesc
 * Generates a changelog file based on the differences between two asset folders or zip files
 * @example
 * const changelogGenerator = new ChangelogGenerator({
 *  previousAssetsPath: './dist-zip/previous',
 *  currentAssetsPath: './dist-zip/current',
 *  destinationPath: './dist-zip',
 *  changelogFilename: 'CHANGELOG.html',
 *  });
 *  changelogGenerator.generateChangelog();
 */
export class ChangelogGenerator {
  private readonly oldAssetsPath: Promise<string>;
  private readonly newAssetsPath: Promise<string>;
  private readonly destinationPath: string;
  private readonly changelogFilename;
  private changelogTemplate = changelogTemplate;
  private readonly diffFileTemplateHandler?: (filename: string, htmlDiff: string) => string;
  private readonly diffLineTemplateHandler?: (diffLine: ChangelogDiffLine) => string;

  private contextLines = 3;

  private logger: ReturnType<typeof createLogger>;

  /**
   * Changelog generator class constructor
   * @param opts
   */
  constructor(opts: ChangelogGeneratorOptions) {
    const {
      oldAssetsPath,
      newAssetsPath,
      destinationPath,
      changelogTemplate,
      diffFileTemplateHandler,
      diffLineTemplateHandler,
      changelogFilename,
      contextLines,
    } = opts;

    this.logger = createLogger();

    if (!oldAssetsPath || !newAssetsPath || !destinationPath) {
      throw new Error('Previous assets path, current assets path and destination path are required');
    }

    if (oldAssetsPath === newAssetsPath) {
      throw new Error('Previous and current assets paths must be different');
    }

    if (!this.isExists(oldAssetsPath)) {
      throw new Error(`Previous assets path ${oldAssetsPath} does not exist`);
    }

    if (!this.isExists(newAssetsPath)) {
      throw new Error(`Current assets path ${newAssetsPath} does not exist`);
    }

    if (this.isZipFile(oldAssetsPath)) {
      const unzipDestinationPath = path.resolve(
        os.tmpdir(),
        crypto.createHash('md5').update(oldAssetsPath).digest('hex'),
      );

      this.oldAssetsPath = this.unzipFile(oldAssetsPath, unzipDestinationPath)
        .then(() => {
          return this.normalizeAssetFolderPath(unzipDestinationPath);
        })
        .then((path) => {
          if (this.isEmptyFolder(path)) {
            throw new Error(`Previous assets path ${path} is empty`);
          }

          return path;
        });
    } else if (this.isFolder(oldAssetsPath)) {
      const path = this.normalizeAssetFolderPath(oldAssetsPath);

      if (this.isEmptyFolder(path)) {
        throw new Error(`Previous assets path ${path} is empty`);
      }

      this.oldAssetsPath = Promise.resolve(path);
    } else {
      throw new Error(`Invalid previous assets path ${oldAssetsPath}. It must be a folder or a zip file`);
    }

    if (this.isZipFile(newAssetsPath)) {
      const unzipDestinationPath = path.resolve(
        os.tmpdir(),
        crypto.createHash('md5').update(newAssetsPath).digest('hex'),
      );

      this.newAssetsPath = this.unzipFile(newAssetsPath, unzipDestinationPath)
        .then(() => {
          return this.normalizeAssetFolderPath(unzipDestinationPath);
        })
        .then((path) => {
          if (this.isEmptyFolder(path)) {
            throw new Error(`Current assets path ${path} is empty`);
          }

          return path;
        });
    } else if (this.isFolder(newAssetsPath)) {
      const path = this.normalizeAssetFolderPath(newAssetsPath);

      if (this.isEmptyFolder(path)) {
        throw new Error(`Current assets path ${newAssetsPath} is empty`);
      }

      this.newAssetsPath = Promise.resolve(path);
    } else {
      throw new Error(`Invalid current assets path ${newAssetsPath}. It must be a folder or a zip file`);
    }

    this.destinationPath = destinationPath;

    this.mkdirpSync(this.destinationPath);

    if (changelogFilename) {
      this.changelogFilename = changelogFilename;
    } else {
      this.changelogFilename = 'CHANGELOG.html';
    }

    if (changelogTemplate) {
      if (this.templateIsValid(changelogTemplate)) {
        this.changelogTemplate = changelogTemplate;
      } else {
        this.logger.warn(colors.yellow('Invalid changelog template, using default'));
      }
    }

    if (typeof diffFileTemplateHandler === 'function') {
      this.diffFileTemplateHandler = diffFileTemplateHandler;
    }

    if (typeof diffLineTemplateHandler === 'function') {
      this.diffLineTemplateHandler = diffLineTemplateHandler;
    }

    if (contextLines) {
      this.contextLines = contextLines;
    }
  }

  private templateIsValid(template: string): boolean {
    return template.includes('%FILES%');
  }

  private isExists(assetPath: string): boolean {
    return fs.existsSync(assetPath);
  }

  private isZipFile(assetPath: string): boolean {
    return assetPath.endsWith('.zip');
  }

  private isFolder(assetPath: string): boolean {
    return fs.lstatSync(assetPath).isDirectory();
  }

  private isEmptyFolder(assetPath: string): boolean {
    return fs.readdirSync(assetPath, { withFileTypes: true }).length === 0;
  }

  private mkdirpSync(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private async unzipFile(assetPath: string, destinationPath: string): Promise<void> {
    fs.rmSync(destinationPath, { force: true, recursive: true });

    return extractZip(assetPath, { dir: destinationPath });
  }

  private normalizeAssetFolderPath(assetPath: string): string {
    const folderContent = fs.readdirSync(assetPath);

    if (folderContent.length === 1 && fs.lstatSync(path.join(assetPath, folderContent[0])).isDirectory()) {
      return this.normalizeAssetFolderPath(path.join(assetPath, folderContent[0]));
    }

    return assetPath;
  }

  private pathToPosix(path: string): string {
    return path.replace(/\\/g, '/');
  }

  private diffTableTemplate(diffLinesHTML: string): string {
    return /* HTML */ `<table class="diff-table">
      <tbody>
        ${diffLinesHTML}
      </tbody>
    </table>`;
  }

  private getDiffTableHTML(diffLines: ChangelogDiffLine[]): string {
    const diffLinesHTML = diffLines
      .filter((value, index, array) => {
        if (value.lineType === LINE_CONTEXT) {
          return (
            (index >= 0 && index < this.contextLines) ||
            (index > array.length - (this.contextLines + 1) && index <= array.length - 1) ||
            array
              .slice(index - this.contextLines, index + this.contextLines + 1)
              .some((line) => line.lineType !== LINE_CONTEXT)
          );
        }

        return true;
      })
      .map((line, index, array) => {
        if (index > 0) {
          const prevLine = array[index - 1];

          if (line.lineNumber - prevLine.lineNumber > 1) {
            return [{ lineNumber: -1, lineContent: '', lineType: LINE_CONTEXT }, line] as ChangelogDiffLine[];
          }
        }

        return [line] as ChangelogDiffLine[];
      })
      .flat()
      .map((line) => this.diffLineHTML(line))
      .join('');

    return this.diffTableTemplate(diffLinesHTML);
  }

  private diffLineMessageTemplate(message: string): string {
    return /* HTML */ `<tr>
      <td class="blob-num"></td>
      <td class="blob-num"></td>
      <td class="blob-code message">
        <span class="blob-code-inner">${message}</span>
      </td>
    </tr>`;
  }

  private diffLineSkipTemplate(): string {
    return /* HTML */ `<tr>
      <td class="blob-num"></td>
      <td class="blob-num"></td>
      <td class="blob-code skip">
        <span class="blob-code-inner">Skip</span>
      </td>
    </tr>`;
  }

  private diffLineTemplate(diffLine: ChangelogDiffLine): string {
    const { lineNumber, lineContent, lineType } = diffLine;

    const numClass = lineType === LINE_ADDED ? 'addition' : lineType === LINE_REMOVED ? 'deletion' : '';
    const codeClass = lineType === LINE_ADDED ? 'code-addition' : lineType === LINE_REMOVED ? 'code-deletion' : '';
    const prefix = lineType === LINE_ADDED ? '+' : lineType === LINE_REMOVED ? '-' : ' ';

    return /* HTML */ `<tr>
      <td
        class="blob-num ${numClass}${numClass === 'addition' ? ' empty' : ''}"
        ${numClass !== 'addition' ? ` data-line-number="${lineNumber}"` : ''}
      ></td>
      <td
        class="blob-num ${numClass}${numClass === 'deletion' ? ' empty' : ''}"
        ${numClass !== 'deletion' ? ` data-line-number="${lineNumber}"` : ''}
      ></td>
      <td class="blob-code ${codeClass}">
        <span class="blob-code-inner" data-code-prefix="${prefix}">${escapeHTMLSequence(lineContent ?? '')}</span>
      </td>
    </tr>`;
  }

  private diffLineHTML(diffLine: ChangelogDiffLine): string {
    if (this.diffLineTemplateHandler) {
      return this.diffLineTemplateHandler(diffLine);
    }

    const { lineNumber } = diffLine;

    if (lineNumber === -1) {
      return this.diffLineSkipTemplate();
    }

    return this.diffLineTemplate(diffLine);
  }

  private diffFileTemplate(filename: string, htmlDiff: string): string {
    if (this.diffFileTemplateHandler) {
      return this.diffFileTemplateHandler(filename, htmlDiff);
    }

    return /* HTML */ `<div class="diff-file">
      <div class="diff-file-title">${filename}</div>
      <div class="diff-file-content">${htmlDiff}</div>
    </div>`;
  }

  private async generateAssetFoldersDiff(): Promise<dirCompare.Difference[]> {
    this.logger.info(
      colors.blue(`Comparing asset folders ${await this.oldAssetsPath} and ${await this.newAssetsPath}`),
    );

    const dirDiff = await dirCompare.compare(await this.oldAssetsPath, await this.newAssetsPath, {
      compareContent: true,
      skipSymlinks: true,
      compareSize: true,
      compareDate: false,
      compareNameHandler: (name1, name2) => {
        if (fileNameWithHashRegEx.test(name1)) {
          name1 = name1.replace(fileNameWithHashRegEx, '$1$3');
        }

        if (fileNameWithHashRegEx.test(name2)) {
          name2 = name2.replace(fileNameWithHashRegEx, '$1$3');
        }

        if (name1.localeCompare(name2) === 0) {
          return 0;
        }

        return name1.localeCompare(name2) > 0 ? 1 : -1;
      },
    });

    return dirDiff.diffSet?.filter((d) => d.state !== 'equal' || d.name1 !== d.name2) || [];
  }

  private async generateAssetFilesDiff(oldFileString: string, newFileString: string): Promise<ChangelogDiffLine[]> {
    const dmp = new DiffMatchPatch();

    const linesChars = dmp.diff_linesToChars_(oldFileString, newFileString);
    const linesDiff = dmp.diff_main(linesChars.chars1, linesChars.chars2, false);

    dmp.diff_charsToLines_(linesDiff, linesChars.lineArray);

    let lineNumber = 0;

    return linesDiff
      .map((diffLine) => {
        const [lineType, lineContent] = diffLine;

        const linesCount = lineContent.endsWith('\n')
          ? lineContent.split('\n').length - 1
          : lineContent.split('\n').length;

        const lines = lineContent
          .split('\n')
          .map((line, index) => {
            return { lineContent: line, lineNumber: lineNumber + index + 1, lineType } as ChangelogDiffLine;
          })
          .slice(0, linesCount);

        if (lineType !== LINE_REMOVED) {
          lineNumber += linesCount;
        }

        return lines;
      })
      .flat();
  }

  /**
   * Generate diff for a file
   * @param difference
   * @private
   */
  private async generateFilesDiff(difference: dirCompare.Difference) {
    if (difference.state === 'equal') {
      const filepath1 = this.pathToPosix(path.join('.', difference.relativePath, difference.name1 ?? ''));
      const filepath2 = this.pathToPosix(path.join('.', difference.relativePath, difference.name2 ?? ''));

      return this.diffFileTemplate(
        /* HTML */ `<span class="renamed"
          >Renamed <span class="from">${filepath1}</span> -> <span class="to">${filepath2}</span></span
        >`,
        this.diffTableTemplate(this.diffLineMessageTemplate('No changes')),
      );
    }

    const assetFile1Path = difference.path1 && difference.name1 ? path.join(difference.path1, difference.name1) : null;
    const assetFile2Path = difference.path2 && difference.name2 ? path.join(difference.path2, difference.name2) : null;

    const filepath = this.pathToPosix(
      path.join('.', difference.relativePath, (difference.name1 || difference.name2) ?? ''),
    );

    if (difference.state === 'left' && assetFile1Path) {
      return this.diffFileTemplate(
        /* HTML */ `<span class="removed">Removed ${filepath}</span>`,
        this.diffTableTemplate(this.diffLineMessageTemplate('File removed')),
      );
    }

    if (difference.state === 'right' && assetFile2Path) {
      return this.diffFileTemplate(
        /* HTML */ `<span class="added">Added ${filepath}</span>`,
        this.diffTableTemplate(this.diffLineMessageTemplate('File added')),
      );
    }

    if (difference.state === 'distinct' && assetFile1Path && assetFile2Path) {
      const filepath1 = this.pathToPosix(path.join('.', difference.relativePath, difference.name1 ?? ''));
      const filepath2 = this.pathToPosix(path.join('.', difference.relativePath, difference.name2 ?? ''));

      const filenameTitle =
        difference.name1 !== difference.name2
          ? /* HTML */ `<span class="renamed"
              >Renamed <span class="from">${filepath1}</span> -> <span class="to">${filepath2}</span></span
            >`
          : filepath;

      return this.diffFileTemplate(
        filenameTitle,
        (await isBinaryFile(assetFile1Path)) || (await isBinaryFile(assetFile2Path))
          ? this.diffTableTemplate(this.diffLineMessageTemplate('Binary file'))
          : this.getDiffTableHTML(
              await this.generateAssetFilesDiff(
                fs.readFileSync(assetFile1Path, 'utf-8'),
                fs.readFileSync(assetFile2Path, 'utf-8'),
              ),
            ),
      );
    }

    return '';
  }

  /**
   * Generate changelog file based on the differences between two asset folders or zip files
   * and write it to the destination folder
   */
  async generateChangelog(): Promise<void> {
    this.logger.info(colors.green('Generating changelog'));

    const diffSet = await this.generateAssetFoldersDiff();

    const htmlDiff = (await Promise.all(diffSet.map((difference) => this.generateFilesDiff(difference)))).join('');

    this.logger.info(colors.green('Writing changelog file'));

    const templateArray = this.changelogTemplate.split('%FILES%');

    templateArray.splice(1, 0, htmlDiff);

    const changelogHTML = templateArray.join('');

    fs.writeFileSync(path.join(this.destinationPath, this.changelogFilename), changelogHTML);

    this.logger.info(
      colors.green(`Changelog file written to ${path.join(this.destinationPath, this.changelogFilename)}`),
    );
  }
}
