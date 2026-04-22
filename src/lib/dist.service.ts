import * as path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import * as crypto from 'crypto';
import * as process from 'process';
import * as child_process from 'child_process';
import * as console from 'console';
import * as os from 'os';
import extractZip from 'extract-zip';
import { createLogger } from './logger.js';
import { Logger } from 'vite';
import { colors } from './helpers/color.helper.js';

export const TEMPLATE_PART_PAGE_NAME = 'pageName';
export const TEMPLATE_PART_DATE = 'date';

const DIRNAME = path.dirname((typeof __filename !== 'undefined' && __filename) || fileURLToPath(import.meta.url));

const pluginPath = path.resolve(DIRNAME, '..', '..');
const node_modules_path = path.resolve(pluginPath, '..', '..');

export interface SyncOptions {
  backupFolder?: string;
  backupNameTemplate?: string;
  dateFormat?: (date: Date) => string;
  distZipFolder?: string;
  distZipFilename?: string;
  versionFileTemplate?: string;
}

export interface SyncMeta {
  lastBackupName: string;
  lastBackupHash: string;
  lastBackupDate: string;
  /** VERSION manifest `checksum` when the last saved backup had a valid VERSION file */
  lastMainHash?: string;
}

interface VersionManifest {
  checksum: string;
  files: Record<string, string>;
}

interface BuildManifest {
  schemaVersion: number;
  manifestType: 'pp-dev-build-manifest';
  generatedAt: string;
  versionFile: string;
  versionFileTemplate: string;
  versionFileSchemaVersion: number;
  buildFingerprint: string;
  compat: {
    versionFileRequired: true;
  };
}

export interface TemplateVariablesBackupInfo {
  relativePath: string;
  content: Buffer;
  actualHash: string;
  manifestHash: string | null;
}

export interface VersionManifestHashMismatch {
  relativePath: string;
  expected: string;
  actual: string;
}

export interface BackupAnalysis {
  backupFingerprint: string;
  unknownFiles: string[];
  templateVariables: TemplateVariablesBackupInfo | null;
  /** VERSION manifest aggregate checksum (`checksum` field); null if no VERSION file */
  mainHash: string | null;
  /** Every zip entry is listed in VERSION (no extras beyond VERSION/BUILD-MANIFEST) */
  allFilesInMeta: boolean;
  /** Set when BUILD-MANIFEST.json `buildFingerprint` differs from the recomputed backup fingerprint */
  buildManifestMismatch: { expected: string; actual: string } | null;
  /** Files present on disk whose SHA-256 does not match VERSION manifest `files` (empty if none or no VERSION) */
  versionManifestHashMismatches: VersionManifestHashMismatch[];
}

const metaDirName = '.pp-dev-meta';
const metaDirPath = path.resolve(node_modules_path, metaDirName);
const metaFilePath = path.resolve(metaDirPath, 'sync-service.meta.json');
const UNKNOWN_FILE_PLACEHOLDER_HASH = '__NOT_IN_VERSION_FILE__';
const BUILD_MANIFEST_FILE_NAME = 'BUILD-MANIFEST.json';

/** Listed in VERSION; basename match for sync UI decisions */
export const TEMPLATE_VARIABLES_FILE_NAME = '__template_variables.json';

export class DistService {
  private readonly backupFolder: string;
  private backupNameTemplate: string;
  private readonly dateFormat: (date: Date) => string;
  private readonly pageName: string;
  private currentMeta: SyncMeta | null = null;
  private readonly distZipFolder: string;
  private readonly distZipFilename: string;
  private readonly versionFileTemplate: string;

  private logger: Logger;

  constructor(pageName: string, syncOptions?: SyncOptions) {
    this.pageName = pageName;

    const {
      backupFolder = path.resolve(process.cwd(), 'backups'),
      distZipFolder = path.resolve(process.cwd(), 'dist-zip'),
      distZipFilename = `${this.pageName}.zip`,
      backupNameTemplate = `{${TEMPLATE_PART_PAGE_NAME}}-{${TEMPLATE_PART_DATE}}.zip`,
      versionFileTemplate = 'VERSION-v{packageversion}-{currentDate}.json',
      dateFormat = (date: Date) => date.toISOString().replace(/:/g, '-').replace(/\..*$/, ''),
    } = syncOptions || {};

    this.backupFolder = backupFolder;
    this.backupNameTemplate = backupNameTemplate;
    this.dateFormat = dateFormat;

    this.distZipFolder = distZipFolder;
    this.distZipFilename = distZipFilename;
    this.versionFileTemplate = versionFileTemplate;

    this.syncMeta();

    this.logger = createLogger();
  }

  async checkMeta() {
    try {
      await fs.stat(metaDirPath);
    } catch {
      await fs.mkdir(metaDirPath);
    }

    try {
      await fs.stat(this.backupFolder);
    } catch {
      await fs.mkdir(this.backupFolder);
    }
  }

  async readMetaFile() {
    await this.checkMeta();

    return await fs
      .readFile(metaFilePath, {
        encoding: 'utf-8',
      })
      .catch(() => '{}');
  }

  async writeMetaFile(meta: SyncMeta) {
    await this.checkMeta();

    return await fs.writeFile(metaFilePath, JSON.stringify(meta, null, 2), {
      encoding: 'utf-8',
    });
  }

  async syncMeta() {
    if (!this.currentMeta) {
      this.currentMeta = JSON.parse(await this.readMetaFile());
    } else {
      await this.writeMetaFile(this.currentMeta);
    }
  }

  async getLatestSavedBackup() {
    const { lastBackupName } = this.currentMeta!;

    if (!lastBackupName) {
      return null;
    }

    const backupPath = path.resolve(this.backupFolder, lastBackupName);

    try {
      await fs.stat(backupPath);

      return backupPath;
    } catch {
      return null;
    }
  }

  backupName(pageName: string, date: Date = new Date()) {
    return this.backupNameTemplate
      .replace(`{${TEMPLATE_PART_PAGE_NAME}}`, pageName)
      .replace(`{${TEMPLATE_PART_DATE}}`, this.dateFormat(date));
  }

  getBackupMeta() {
    return this.currentMeta;
  }

  private pathToPosix(filePath: string): string {
    return filePath.replace(/\\/g, '/');
  }

  private async normalizeExtractedRootDir(extractedDir: string): Promise<string> {
    let currentDir = extractedDir;

    while (true) {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });

      if (entries.length !== 1 || !entries[0]?.isDirectory()) {
        return currentDir;
      }

      currentDir = path.join(currentDir, entries[0].name);
    }
  }

  private async listFilesRecursive(rootDir: string): Promise<string[]> {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = path.join(rootDir, entry.name);

      if (entry.isDirectory()) {
        files.push(...(await this.listFilesRecursive(fullPath)));
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }

    return files;
  }

  private buildManifestChecksum(files: Record<string, string>): string {
    const sortedPaths = Object.keys(files).sort();
    const hashesConcatenated = sortedPaths.map((value) => files[value]).join('');

    return crypto.createHash('sha256').update(hashesConcatenated).digest('hex');
  }

  private buildBackupFingerprint(files: Record<string, string>): string {
    const normalizedEntries = Object.keys(files)
      .sort()
      .map((value) => `${value}:${files[value]}`)
      .join('\n');

    return crypto.createHash('sha256').update(normalizedEntries, 'utf-8').digest('hex');
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private versionFileTemplateMatcher(): RegExp {
    const placeholderPattern = /\{[^}]+\}/g;
    const segments: string[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null = null;

    while (true) {
      match = placeholderPattern.exec(this.versionFileTemplate);

      if (!match) {
        break;
      }

      const [placeholder] = match;
      const staticPart = this.versionFileTemplate.slice(lastIndex, match.index);

      segments.push(this.escapeRegExp(staticPart));
      segments.push('[^/]+');

      lastIndex = match.index + placeholder.length;
    }

    const trailingStaticPart = this.versionFileTemplate.slice(lastIndex);
    segments.push(this.escapeRegExp(trailingStaticPart));

    return new RegExp(`^${segments.join('')}$`, 'i');
  }

  private isTemplateVariablesBasename(fileBasename: string): boolean {
    return fileBasename === TEMPLATE_VARIABLES_FILE_NAME;
  }

  /** Resolve `__template_variables.json` from backup ZIP (server copy). */
  private async pickTemplateVariablesFromBackupZip(
    relativePaths: string[],
    contentRootDir: string,
  ): Promise<TemplateVariablesBackupInfo | null> {
    const relativePath = relativePaths.find((p) => path.basename(p) === TEMPLATE_VARIABLES_FILE_NAME);

    if (!relativePath) {
      return null;
    }

    const absolutePath = path.join(contentRootDir, relativePath);
    const fileData = await fs.readFile(absolutePath);
    const actualHash = crypto.createHash('sha256').update(fileData).digest('hex');

    return {
      relativePath,
      content: fileData,
      actualHash,
      manifestHash: null,
    };
  }

  private async resolveBackupAnalysisFromZip(backupFile: Buffer): Promise<BackupAnalysis> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-dev-backup-'));
    const zipPath = path.join(tempDir, 'backup.zip');
    const extractedDir = path.join(tempDir, 'extracted');

    try {
      await fs.mkdir(extractedDir, { recursive: true });
      await fs.writeFile(zipPath, backupFile);
      await extractZip(zipPath, { dir: extractedDir });

      const contentRootDir = await this.normalizeExtractedRootDir(extractedDir);
      const allFiles = await this.listFilesRecursive(contentRootDir);
      const relativePaths = allFiles.map((filePath) => this.pathToPosix(path.relative(contentRootDir, filePath)));

      const buildManifestCandidates = relativePaths.filter(
        (filePath) => path.basename(filePath) === BUILD_MANIFEST_FILE_NAME,
      );

      if (buildManifestCandidates.length > 1) {
        throw new Error(
          `Expected at most one ${BUILD_MANIFEST_FILE_NAME} in backup ZIP, found ${buildManifestCandidates.length}`,
        );
      }

      const buildManifestPath = buildManifestCandidates.length === 1 ? buildManifestCandidates[0]! : null;

      let buildManifest: BuildManifest | null = null;

      if (buildManifestPath) {
        const buildManifestAbsolutePath = path.join(contentRootDir, buildManifestPath);
        buildManifest = JSON.parse(await fs.readFile(buildManifestAbsolutePath, 'utf-8')) as BuildManifest;

        if (
          !buildManifest ||
          buildManifest.manifestType !== 'pp-dev-build-manifest' ||
          typeof buildManifest.versionFile !== 'string' ||
          !buildManifest.versionFile.trim() ||
          typeof buildManifest.versionFileTemplate !== 'string' ||
          !buildManifest.versionFileTemplate.trim() ||
          typeof buildManifest.buildFingerprint !== 'string' ||
          !buildManifest.buildFingerprint.trim()
        ) {
          throw new Error('Build manifest is missing required fields');
        }
      }

      let versionManifestPath: string | null = null;

      if (buildManifest) {
        const requestedVersionFile = this.pathToPosix(buildManifest.versionFile.trim());
        const exactMatchCandidates = relativePaths.filter((filePath) => filePath === requestedVersionFile);
        const basenameMatchCandidates = relativePaths.filter(
          (filePath) => path.basename(filePath) === path.basename(requestedVersionFile),
        );
        const resolvedCandidates = exactMatchCandidates.length > 0 ? exactMatchCandidates : basenameMatchCandidates;

        if (resolvedCandidates.length > 1) {
          throw new Error(
            `Build manifest version file "${buildManifest.versionFile}" must resolve to exactly one file in backup ZIP, found ${resolvedCandidates.length}`,
          );
        }

        if (resolvedCandidates.length === 1) {
          versionManifestPath = resolvedCandidates[0]!;
        }

        if (buildManifest.compat?.versionFileRequired === true && versionManifestPath === null) {
          throw new Error(
            `Build manifest requires version file "${buildManifest.versionFile}", but it is missing in backup ZIP`,
          );
        }
      } else {
        const versionFileMatcher = this.versionFileTemplateMatcher();
        const versionManifestCandidates = relativePaths.filter((filePath) =>
          versionFileMatcher.test(path.basename(filePath)),
        );

        if (versionManifestCandidates.length > 1) {
          throw new Error(
            `Expected exactly one version file matching template "${this.versionFileTemplate}" in backup ZIP, found ${versionManifestCandidates.length}`,
          );
        }

        if (versionManifestCandidates.length === 1) {
          versionManifestPath = versionManifestCandidates[0]!;
        }
      }

      const normalizedManifestFiles: Record<string, string> = {};
      let templateVariables: TemplateVariablesBackupInfo | null = null;
      let manifestChecksum: string | null = null;
      const manifestFileActualHashes: Record<string, string> = {};
      let versionManifestHashMismatches: VersionManifestHashMismatch[] = [];

      if (versionManifestPath) {
        const versionManifestAbsolutePath = path.join(contentRootDir, versionManifestPath);
        const manifest = JSON.parse(await fs.readFile(versionManifestAbsolutePath, 'utf-8')) as VersionManifest;

        if (!manifest?.files || typeof manifest.files !== 'object') {
          throw new Error('VERSION manifest files map is missing or invalid');
        }

        if (typeof manifest.checksum !== 'string' || !manifest.checksum) {
          throw new Error('VERSION manifest checksum is missing or invalid');
        }

        manifestChecksum = manifest.checksum;

        for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
          if (typeof expectedHash !== 'string' || !expectedHash.trim()) {
            throw new Error(`VERSION manifest contains invalid hash for file: ${relativePath}`);
          }

          normalizedManifestFiles[this.pathToPosix(relativePath)] = expectedHash;
        }

        const calculatedManifestChecksum = this.buildManifestChecksum(normalizedManifestFiles);

        if (calculatedManifestChecksum !== manifest.checksum) {
          throw new Error('VERSION manifest checksum does not match its files map');
        }

        for (const [relativePath, expectedHash] of Object.entries(normalizedManifestFiles)) {
          const absolutePath = path.join(contentRootDir, relativePath);
          const fileData = await fs.readFile(absolutePath).catch(() => null);

          if (!fileData) {
            throw new Error(`VERSION manifest references missing file: ${relativePath}`);
          }

          const actualHash = crypto.createHash('sha256').update(fileData).digest('hex');

          manifestFileActualHashes[relativePath] = actualHash;

          if (actualHash !== expectedHash) {
            versionManifestHashMismatches.push({ relativePath, expected: expectedHash, actual: actualHash });
          }

          if (this.isTemplateVariablesBasename(path.basename(relativePath))) {
            templateVariables = {
              relativePath,
              content: fileData,
              actualHash,
              manifestHash: expectedHash,
            };
          }
        }

        if (versionManifestHashMismatches.length > 0) {
          this.logger.warn(
            colors.yellow(
              `[DistService] VERSION manifest hash mismatch for ${versionManifestHashMismatches.length} file(s) (confirm in UI): ${versionManifestHashMismatches.map((m) => m.relativePath).join(', ')}`,
            ),
          );
        }
      }

      const mismatchedManifestPaths = new Set(versionManifestHashMismatches.map((m) => m.relativePath));

      const fingerprintFiles: Record<string, string> = {};
      const unknownFiles: string[] = [];

      for (const relativePath of relativePaths) {
        if (relativePath === buildManifestPath) {
          continue;
        }

        if (versionManifestPath && relativePath === versionManifestPath) {
          continue;
        }

        if (versionManifestPath && Object.prototype.hasOwnProperty.call(fingerprintFiles, relativePath)) {
          continue;
        }

        const absolutePath = path.join(contentRootDir, relativePath);
        const fileData = await fs.readFile(absolutePath);
        const actualHash = crypto.createHash('sha256').update(fileData).digest('hex');

        if (versionManifestPath && Object.prototype.hasOwnProperty.call(normalizedManifestFiles, relativePath)) {
          fingerprintFiles[relativePath] = mismatchedManifestPaths.has(relativePath)
            ? manifestFileActualHashes[relativePath]!
            : normalizedManifestFiles[relativePath]!;
        } else if (versionManifestPath) {
          fingerprintFiles[relativePath] = UNKNOWN_FILE_PLACEHOLDER_HASH;
          unknownFiles.push(relativePath);
        } else {
          fingerprintFiles[relativePath] = actualHash;
        }
      }

      if (!templateVariables) {
        templateVariables = await this.pickTemplateVariablesFromBackupZip(relativePaths, contentRootDir);
      }

      const backupFingerprint = this.buildBackupFingerprint(fingerprintFiles);

      let buildManifestMismatch: { expected: string; actual: string } | null = null;

      if (buildManifest && versionManifestPath && backupFingerprint !== buildManifest.buildFingerprint) {
        buildManifestMismatch = {
          expected: buildManifest.buildFingerprint,
          actual: backupFingerprint,
        };

        this.logger.warn(
          colors.yellow(
            `[DistService] Build manifest fingerprint mismatch (confirm in UI): expected ${buildManifest.buildFingerprint}, got ${backupFingerprint}`,
          ),
        );
      }

      return {
        backupFingerprint,
        unknownFiles,
        templateVariables,
        mainHash: manifestChecksum,
        allFilesInMeta: Boolean(versionManifestPath && unknownFiles.length === 0),
        buildManifestMismatch,
        versionManifestHashMismatches,
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  async analyzeBackup(backupFile: Buffer): Promise<BackupAnalysis> {
    // Verify if the backup file is an ZIP file (magic number)
    if (backupFile.toString('utf-8').slice(0, 4) !== 'PK\x03\x04') {
      throw new Error('Backup file is not a ZIP file');
    }

    return await this.resolveBackupAnalysisFromZip(backupFile);
  }

  async getPublicTemplateVariablesHash(): Promise<string | null> {
    const templateVariablesPath = path.resolve(process.cwd(), 'public', TEMPLATE_VARIABLES_FILE_NAME);
    const fileData = await fs.readFile(templateVariablesPath).catch(() => null);

    if (!fileData) {
      return null;
    }

    return crypto.createHash('sha256').update(fileData).digest('hex');
  }

  async saveTemplateVariablesFile(content: Buffer): Promise<string> {
    const templateVariablesPath = path.resolve(process.cwd(), 'public', TEMPLATE_VARIABLES_FILE_NAME);

    await fs.mkdir(path.dirname(templateVariablesPath), { recursive: true });
    await fs.writeFile(templateVariablesPath, content);

    return templateVariablesPath;
  }

  async saveBackup(backupFile: Buffer, precomputedAnalysis?: BackupAnalysis) {
    const resolvedAnalysis = precomputedAnalysis ?? (await this.analyzeBackup(backupFile));
    const resolvedBackupFileHash = resolvedAnalysis.backupFingerprint;
    const lastSavedBackup = await this.getLatestSavedBackup();

    if (lastSavedBackup) {
      const { lastBackupHash, lastMainHash } = this.currentMeta!;

      if (lastBackupHash === resolvedBackupFileHash) {
        this.logger.info(
          colors.yellow(
            `[DistService] Backup skipped: same backup fingerprint as last saved (${resolvedBackupFileHash.slice(0, 12)}...)`,
          ),
        );

        return;
      }

      if (resolvedAnalysis.allFilesInMeta && resolvedAnalysis.mainHash && lastMainHash === resolvedAnalysis.mainHash) {
        this.logger.info(
          colors.yellow(
            `[DistService] Backup skipped: same VERSION manifest checksum (main hash) and all files listed in VERSION`,
          ),
        );

        return;
      }
    }

    const backupDate = new Date();

    const filename = this.backupName(this.pageName, backupDate);

    this.currentMeta!.lastBackupName = filename;
    this.currentMeta!.lastBackupHash = resolvedBackupFileHash;
    this.currentMeta!.lastBackupDate = backupDate.toISOString();

    if (resolvedAnalysis.mainHash) {
      this.currentMeta!.lastMainHash = resolvedAnalysis.mainHash;
    } else {
      delete this.currentMeta!.lastMainHash;
    }

    await this.syncMeta();

    return await fs.writeFile(path.resolve(this.backupFolder, filename), backupFile).finally(() => {
      this.logger.info(`Backup saved to ${filename}`);
    });
  }

  async buildNewAssets() {
    const buildCommand = new Promise<string>((resolve, reject) => {
      let data = '';

      // Colorized log output with message about build start
      this.logger.info(colors.cyan('[DistService] Build started'));

      const proc = child_process.spawn('node', [path.resolve(pluginPath, './bin/pp-dev.js'), 'build'], {
        cwd: process.cwd(),
        env: Object.assign({}, process.env, { NODE_ENV: 'production' }),
        stdio: 'inherit',
      });

      proc.on('message', (msg) => {
        data += msg;
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`build command exited with code ${code}`));

          return;
        }

        resolve(data);
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });

    try {
      await buildCommand.finally(() => {
        // Colorized log output with message about build end
        this.logger.info(colors.cyan('[DistService] Build finished'));
      });

      const assetFile = path.resolve(process.cwd(), this.distZipFolder, this.distZipFilename);

      if (!(await fs.stat(assetFile))) {
        throw new Error(`File ${assetFile} not found`);
      }

      return await fs.readFile(assetFile);
    } catch (e) {
      console.log(e);

      throw e;
    }
  }

  async saveBackupAndBuild(backupFile: Buffer) {
    await this.saveBackup(backupFile);

    return await this.buildNewAssets();
  }
}
