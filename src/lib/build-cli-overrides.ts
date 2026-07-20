/**
 * CLI/env overrides for build-output options (dist-zip folder/filename, VERSION manifest),
 * shared by the Vite `build` command and the Next.js `next-build` command so both produce
 * build artifacts in the same format and can be tuned the same way (e.g. from CI).
 *
 * Precedence: CLI flag > `PP_DEV_*` env var > pp-dev config (`build.zip` / `build.versionFile`).
 */

export interface BuildOverrideCLIOptions {
  distZip?: boolean;
  distZipDir?: string;
  distZipFilename?: string;
  versionManifest?: boolean;
  versionFileTemplate?: string;
}

export interface ResolvedBuildCliOverrides {
  distZipEnabled?: boolean;
  distZipDir?: string;
  distZipFilename?: string;
  versionManifestEnabled?: boolean;
  versionFileTemplate?: string;
}

export interface DistZipConfig {
  outFileName: string;
  outDir: string;
  inDir?: string;
}

export interface VersionManifestConfig {
  versionFileTemplate?: string;
  enabled?: boolean;
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === '1' || value.toLowerCase() === 'true') {
    return true;
  }

  if (value === '0' || value.toLowerCase() === 'false') {
    return false;
  }

  return undefined;
}

export function resolveBuildCliOverrides(options: BuildOverrideCLIOptions): ResolvedBuildCliOverrides {
  return {
    distZipEnabled: options.distZip ?? parseBooleanFlag(process.env.PP_DEV_DIST_ZIP),
    distZipDir: options.distZipDir ?? process.env.PP_DEV_DIST_ZIP_DIR,
    distZipFilename: options.distZipFilename ?? process.env.PP_DEV_DIST_ZIP_FILENAME,
    versionManifestEnabled: options.versionManifest ?? parseBooleanFlag(process.env.PP_DEV_VERSION_MANIFEST),
    versionFileTemplate: options.versionFileTemplate ?? process.env.PP_DEV_VERSION_FILE_TEMPLATE,
  };
}

/** Apply resolved overrides onto a `build.zip`-derived base config (false disables entirely). */
export function applyDistZipOverride(
  base: false | DistZipConfig,
  overrides: ResolvedBuildCliOverrides,
  defaultFileName: string,
): false | DistZipConfig {
  if (overrides.distZipEnabled === false) {
    return false;
  }

  if (overrides.distZipEnabled !== true && overrides.distZipDir === undefined && overrides.distZipFilename === undefined) {
    return base;
  }

  const baseConfig: DistZipConfig = base === false ? { outFileName: defaultFileName, outDir: 'dist-zip' } : base;

  return {
    ...baseConfig,
    ...(overrides.distZipDir !== undefined ? { outDir: overrides.distZipDir } : {}),
    ...(overrides.distZipFilename !== undefined ? { outFileName: overrides.distZipFilename } : {}),
  };
}

/** Apply resolved overrides onto a `build.versionFile`-derived base config (false disables entirely). */
export function applyVersionManifestOverride(
  base: false | VersionManifestConfig,
  overrides: ResolvedBuildCliOverrides,
): false | VersionManifestConfig {
  if (overrides.versionManifestEnabled === false) {
    return false;
  }

  if (overrides.versionManifestEnabled !== true && overrides.versionFileTemplate === undefined) {
    return base;
  }

  const baseConfig: VersionManifestConfig = base === false ? { enabled: true } : base;

  return {
    ...baseConfig,
    enabled: true,
    ...(overrides.versionFileTemplate !== undefined ? { versionFileTemplate: overrides.versionFileTemplate } : {}),
  };
}
