import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

  it('normalizes .svg files to match MI (PP-4123) before hashing, so the manifest matches what actually ships', () => {
    const outDir = mkdtempSync(path.join(tmpdir(), 'pp-dev-version-manifest-'));

    try {
      const svgPath = path.join(outDir, 'icon.svg');

      // SVGO-style minified input: self-closing, no XML declaration.
      writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');

      writeBuildVersionManifest({ outDir, packageVersion: '1.0.0' });

      const normalizedOnDisk = readFileSync(svgPath, 'utf-8');

      // The optimizer's self-closing form must actually have been rewritten, not left as-is.
      expect(normalizedOnDisk).not.toContain('/>');
      expect(normalizedOnDisk.startsWith('<?xml')).toBe(true);

      const [versionFileName] = readFileSync(path.join(outDir, 'BUILD-MANIFEST.json'), 'utf-8').match(
        /"versionFile":\s*"([^"]+)"/,
      )!.slice(1) as [string];
      const manifest = JSON.parse(readFileSync(path.join(outDir, versionFileName), 'utf-8'));
      const expectedHash = createHash('sha256').update(normalizedOnDisk).digest('hex');

      expect(manifest.files['icon.svg']).toBe(expectedHash);
    } finally {
      rmSync(outDir, { force: true, recursive: true });
    }
  });
});
