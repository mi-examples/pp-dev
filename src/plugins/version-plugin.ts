import { createHash } from 'crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import type { Plugin } from 'vite';
import type { VersionPluginOptions } from '../plugin.js';

interface VersionPluginConfig extends VersionPluginOptions {
  outDir: string;
  packageVersion: string;
}

interface VersionManifest {
  version: string;
  date: string;
  checksum: string;
  files: Record<string, string>;
}

function walkDir(dir: string, baseDir: string, excludeFile?: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      files.push(...walkDir(fullPath, baseDir, excludeFile));
    } else if (entry.isFile() && relativePath !== excludeFile) {
      files.push(fullPath);
    }
  }

  return files;
}

function sha256OfContent(filePath: string): string {
  const content = readFileSync(filePath);

  return createHash('sha256').update(content).digest('hex');
}

function computeChecksum(files: Record<string, string>): string {
  const sortedPaths = Object.keys(files).sort();
  const hashesConcatenated = sortedPaths.map((p) => files[p]).join('');

  return createHash('sha256').update(hashesConcatenated).digest('hex');
}

function resolveVersionFileName(
  template: string,
  packageVersion: string,
  currentDate: string,
): string {
  return template
    .replace(/\{packageversion\}/g, packageVersion)
    .replace(/\{currentDate\}/g, currentDate);
}

export function versionPlugin(config: VersionPluginConfig): Plugin {
  return {
    name: 'pp-dev-version',
    apply: 'build',
    enforce: 'post',

    closeBundle() {
      if (config.enabled === false) {
        return;
      }

      const { outDir, versionFileTemplate, packageVersion } = config;
      const outDirResolved = path.resolve(process.cwd(), outDir);

      if (!statSync(outDirResolved, { throwIfNoEntry: false })?.isDirectory()) {
        return;
      }

      const now = new Date();
      const manifestDate = now.toISOString();
      const currentDate = manifestDate.replace(/:/g, '-');
      const versionFileName = resolveVersionFileName(
        versionFileTemplate ?? 'VERSION-v{packageversion}-{currentDate}.json',
        packageVersion,
        currentDate,
      );

      const allPaths = walkDir(outDirResolved, outDirResolved, versionFileName);
      const files: Record<string, string> = {};

      for (const filePath of allPaths) {
        const relativePath = path.relative(outDirResolved, filePath).replace(/\\/g, '/');
        
        files[relativePath] = sha256OfContent(filePath);
      }

      const checksum = computeChecksum(files);

      const manifest: VersionManifest = {
        version: `v${packageVersion}`,
        date: manifestDate,
        checksum,
        files,
      };

      const manifestPath = path.join(outDirResolved, versionFileName);

      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    },
  };
}
