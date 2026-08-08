import { describe, expect, it } from 'vitest';
import { applyDistZipOverride, applyVersionManifestOverride } from '../../../src/lib/build-cli-overrides.js';

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
