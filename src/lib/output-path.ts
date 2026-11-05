import path from 'node:path';

/**
 * Normalize an output path supplied relative to a configured output directory. Both slash
 * styles are accepted so existing cross-platform configs keep working. Parent segments are
 * allowed only when they normalize to a location that remains inside the output directory.
 */
export function normalizeRelativeOutputPath(relativePath: string, optionName: string): string {
  if (
    !relativePath ||
    relativePath.includes('\0') ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    path.win32.parse(relativePath).root
  ) {
    throw new Error(`[pp-dev] ${optionName} must be a relative path inside its output directory.`);
  }

  const normalized = path.posix.normalize(relativePath.replace(/\\/g, '/'));

  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`[pp-dev] ${optionName} must stay inside its output directory.`);
  }

  return normalized;
}

export function createDefaultZipFileName(appName: string): string {
  const fileName = `${appName.replace(/^@/, '').replace(/[\\/]+/g, '-')}.zip`;

  return normalizeRelativeOutputPath(fileName, 'default ZIP output file name');
}

/**
 * The directory a build packs into its ZIP: `build.zip.inDir` against the project root, as the Vite
 * build (`vite-plugin-zip-pack`, cwd) and the sync (`DistService`, root) read it; the build output
 * directory without it.
 */
export function resolveZipSourceDir(projectRoot: string, outDir: string, inDir: string | undefined): string {
  return path.resolve(projectRoot, inDir || outDir);
}

export function resolveOutputFilePath(directory: string, fileName: string, optionName: string): string {
  const safeRelativePath = normalizeRelativeOutputPath(fileName, optionName);
  const resolvedDirectory = path.resolve(directory);
  const resolvedFile = path.resolve(resolvedDirectory, ...safeRelativePath.split('/'));
  const relativeToDirectory = path.relative(resolvedDirectory, resolvedFile);

  if (
    relativeToDirectory === '..' ||
    relativeToDirectory.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToDirectory)
  ) {
    throw new Error(`[pp-dev] ${optionName} must resolve inside its output directory.`);
  }

  return resolvedFile;
}
