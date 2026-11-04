import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDefaultZipFileName,
  normalizeRelativeOutputPath,
  resolveOutputFilePath,
  resolveZipSourceDir,
} from '../../../src/lib/output-path.js';

describe('output path validation', () => {
  it('accepts a plain file name and resolves it inside the output directory', () => {
    const outputDir = path.resolve('dist-zip');

    expect(normalizeRelativeOutputPath('portal-page.zip', 'ZIP output file name')).toBe('portal-page.zip');
    expect(resolveOutputFilePath(outputDir, 'portal-page.zip', 'ZIP output file name')).toBe(
      path.join(outputDir, 'portal-page.zip'),
    );
  });

  it.each(['nested/archive.zip', 'nested\\archive.zip', 'old/../archive.zip'])(
    'allows a relative path that stays inside the output directory: %s',
    (fileName) => {
      expect(normalizeRelativeOutputPath(fileName, 'ZIP output file name')).toBe(
        fileName === 'old/../archive.zip' ? 'archive.zip' : 'nested/archive.zip',
      );
    },
  );

  it.each(['../package.json', '..\\package.json', '/tmp/archive.zip', 'C:\\temp\\archive.zip', '..', ''])(
    'rejects a path outside the output directory: %s',
    (fileName) => {
      expect(() => normalizeRelativeOutputPath(fileName, 'ZIP output file name')).toThrow(
        /must (?:be a relative path|stay) inside its output directory/,
      );
    },
  );

  it('resolves nested output paths inside the configured directory', () => {
    const outputDir = path.resolve('dist-zip');

    expect(resolveOutputFilePath(outputDir, 'nested/archive.zip', 'ZIP output file name')).toBe(
      path.join(outputDir, 'nested', 'archive.zip'),
    );
  });

  it('creates a safe default ZIP name for a scoped package', () => {
    expect(createDefaultZipFileName('@metricinsights/portal-page')).toBe('metricinsights-portal-page.zip');
  });

  // `pp-dev next-build` resolved `build.zip.inDir` against the export directory, so an `inDir` that
  // works for `pp-dev build` and the sync (both read it from the project root) gave `out/out/...`.
  it('packs build.zip.inDir from the project root, as the Vite build and the sync read it', () => {
    const root = path.resolve('project');

    expect(resolveZipSourceDir(root, 'out', undefined)).toBe(path.join(root, 'out'));
    expect(resolveZipSourceDir(root, 'out', 'out/portal')).toBe(path.join(root, 'out', 'portal'));
    expect(resolveZipSourceDir(root, 'out', path.join(root, 'elsewhere'))).toBe(path.join(root, 'elsewhere'));
  });
});
