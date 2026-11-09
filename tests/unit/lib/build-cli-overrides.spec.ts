import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyDistZipOverride,
  applyVersionManifestOverride,
  resolveBuildCliOverrides,
} from '../../../src/lib/build-cli-overrides.js';

describe('build output CLI overrides', () => {
  it('rejects a ZIP filename that escapes the configured output directory', () => {
    expect(() =>
      applyDistZipOverride(
        { outFileName: 'app.zip', outDir: 'dist-zip' },
        { distZipFilename: '../package.json' },
        'app.zip',
      ),
    ).toThrow('ZIP output file name must stay inside its output directory');
  });

  it('preserves a nested ZIP path inside the output directory', () => {
    expect(
      applyDistZipOverride(
        { outFileName: 'app.zip', outDir: 'dist-zip' },
        { distZipFilename: 'releases/app.zip' },
        'app.zip',
      ),
    ).toMatchObject({ outFileName: 'releases/app.zip', outDir: 'dist-zip' });
  });

  it('rejects a VERSION template that escapes the build directory', () => {
    expect(() =>
      applyVersionManifestOverride(
        { enabled: true, versionFileTemplate: 'VERSION.json' },
        { versionFileTemplate: '..\\package.json' },
      ),
    ).toThrow('VERSION file name template must stay inside its output directory');
  });
});

// CLI flag > `PP_DEV_*` env var > pp-dev config (`build.zip` / `build.versionFile`).
describe('build output override precedence', () => {
  const zipConfig = { outFileName: 'config.zip', outDir: 'config-zip' };

  // Each test starts without the overrides, whatever the shell running the tests has set.
  beforeEach(() => {
    for (const name of [
      'PP_DEV_DIST_ZIP',
      'PP_DEV_DIST_ZIP_DIR',
      'PP_DEV_DIST_ZIP_FILENAME',
      'PP_DEV_VERSION_MANIFEST',
      'PP_DEV_VERSION_FILE_TEMPLATE',
    ]) {
      vi.stubEnv(name, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('takes a CLI flag over the env var', () => {
    vi.stubEnv('PP_DEV_DIST_ZIP', 'true');
    vi.stubEnv('PP_DEV_DIST_ZIP_DIR', 'env-zip');
    vi.stubEnv('PP_DEV_DIST_ZIP_FILENAME', 'env.zip');
    vi.stubEnv('PP_DEV_VERSION_MANIFEST', 'true');
    vi.stubEnv('PP_DEV_VERSION_FILE_TEMPLATE', 'ENV-VERSION');

    expect(
      resolveBuildCliOverrides({
        distZip: false,
        distZipDir: 'cli-zip',
        distZipFilename: 'cli.zip',
        versionManifest: false,
        versionFileTemplate: 'CLI-VERSION',
      }),
    ).toEqual({
      distZipEnabled: false,
      distZipDir: 'cli-zip',
      distZipFilename: 'cli.zip',
      versionManifestEnabled: false,
      versionFileTemplate: 'CLI-VERSION',
    });
  });

  it('takes the env var when there is no CLI flag', () => {
    vi.stubEnv('PP_DEV_DIST_ZIP', '1');
    vi.stubEnv('PP_DEV_DIST_ZIP_DIR', 'env-zip');
    vi.stubEnv('PP_DEV_VERSION_MANIFEST', 'FALSE');

    expect(resolveBuildCliOverrides({})).toMatchObject({
      distZipEnabled: true,
      distZipDir: 'env-zip',
      versionManifestEnabled: false,
    });
  });

  it('ignores an env flag that is neither true/1 nor false/0', () => {
    vi.stubEnv('PP_DEV_DIST_ZIP', 'yes');
    vi.stubEnv('PP_DEV_VERSION_MANIFEST', '');

    expect(resolveBuildCliOverrides({})).toMatchObject({
      distZipEnabled: undefined,
      versionManifestEnabled: undefined,
    });
  });

  it('applies the env var over the config', () => {
    vi.stubEnv('PP_DEV_DIST_ZIP_DIR', 'env-zip');
    vi.stubEnv('PP_DEV_VERSION_FILE_TEMPLATE', 'ENV-VERSION');

    const overrides = resolveBuildCliOverrides({});

    expect(applyDistZipOverride(zipConfig, overrides, 'default.zip')).toEqual({
      outFileName: 'config.zip',
      outDir: 'env-zip',
    });
    expect(applyVersionManifestOverride({ enabled: true, versionFileTemplate: 'VERSION' }, overrides)).toEqual({
      enabled: true,
      versionFileTemplate: 'ENV-VERSION',
    });
  });

  it('keeps the config when neither a CLI flag nor an env var is set', () => {
    const overrides = resolveBuildCliOverrides({});

    expect(applyDistZipOverride(zipConfig, overrides, 'default.zip')).toEqual(zipConfig);
    expect(applyDistZipOverride(false, overrides, 'default.zip')).toBe(false);
    expect(applyVersionManifestOverride(false, overrides)).toBe(false);
  });

  it('turns on an output the config turned off when the env var asks for it', () => {
    vi.stubEnv('PP_DEV_DIST_ZIP_FILENAME', 'env.zip');
    vi.stubEnv('PP_DEV_VERSION_MANIFEST', 'true');

    const overrides = resolveBuildCliOverrides({});

    expect(applyDistZipOverride(false, overrides, 'default.zip')).toEqual({
      outFileName: 'env.zip',
      outDir: 'dist-zip',
    });
    expect(applyVersionManifestOverride(false, overrides)).toEqual({ enabled: true });
  });

  it('turns off an output the config turned on when the CLI says so, whatever the env var', () => {
    vi.stubEnv('PP_DEV_DIST_ZIP', 'true');
    vi.stubEnv('PP_DEV_VERSION_MANIFEST', 'true');

    const overrides = resolveBuildCliOverrides({ distZip: false, versionManifest: false });

    expect(applyDistZipOverride(zipConfig, overrides, 'default.zip')).toBe(false);
    expect(applyVersionManifestOverride({ enabled: true }, overrides)).toBe(false);
  });
});
