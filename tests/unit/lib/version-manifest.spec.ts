import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeBuildVersionManifest } from '../../../src/lib/version-manifest.js';

describe('writeBuildVersionManifest output path', () => {
  it('rejects a generated VERSION filename outside the build directory', () => {
    const outDir = mkdtempSync(path.join(tmpdir(), 'pp-dev-version-manifest-'));

    try {
      expect(() =>
        writeBuildVersionManifest({
          outDir,
          packageVersion: '1.0.0',
          versionFileTemplate: '../package.json',
        }),
      ).toThrow('VERSION output file name must stay inside its output directory');
    } finally {
      rmSync(outDir, { force: true, recursive: true });
    }
  });

  it('creates parent directories for a nested VERSION path', () => {
    const outDir = mkdtempSync(path.join(tmpdir(), 'pp-dev-version-manifest-'));

    try {
      writeBuildVersionManifest({
        outDir,
        packageVersion: '1.0.0',
        versionFileTemplate: 'metadata/VERSION.json',
      });

      expect(existsSync(path.join(outDir, 'metadata', 'VERSION.json'))).toBe(true);
      expect(existsSync(path.join(outDir, 'BUILD-MANIFEST.json'))).toBe(true);
    } finally {
      rmSync(outDir, { force: true, recursive: true });
    }
  });

  it('resolves a relative outDir against the explicit root, not process.cwd()', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pp-dev-version-manifest-root-'));
    const originalCwd = process.cwd();

    try {
      mkdirSync(path.join(root, 'dist'));
      process.chdir(tmpdir());

      writeBuildVersionManifest({
        outDir: 'dist',
        root,
        packageVersion: '1.0.0',
      });

      expect(existsSync(path.join(root, 'dist', 'BUILD-MANIFEST.json'))).toBe(true);
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { force: true, recursive: true });
    }
  });
});
