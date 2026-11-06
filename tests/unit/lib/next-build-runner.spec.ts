import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { configuredNextDistDir, removeStaleDevTypes } from '../../../src/lib/next-build-runner';

describe('configuredNextDistDir', () => {
  it('is the configured distDir, which Next 16 reports as distDirRoot in development', () => {
    expect(configuredNextDistDir({ distDir: 'dist/dev', distDirRoot: 'dist' })).toBe('dist');
  });

  // Next sets distDirRoot when it appends /dev, and only then: a version that reports the
  // configured distDir as it is keeps a `build/dev` of its own (a trailing /dev was stripped).
  it('is the configured one, as it is, on Next versions that keep it in development', () => {
    expect(configuredNextDistDir({ distDir: 'build' })).toBe('build');
    expect(configuredNextDistDir({ distDir: 'build/dev' })).toBe('build/dev');
    expect(configuredNextDistDir({ distDir: 'build\\dev\\' })).toBe('build/dev');
  });

  it('is .next without a config', () => {
    expect(configuredNextDistDir(undefined)).toBe('.next');
    expect(configuredNextDistDir({})).toBe('.next');
  });
});

describe('removeStaleDevTypes', () => {
  let root: string;

  const seedDevTypes = (distDir: string) => {
    const dir = join(root, distDir, 'dev', 'types');

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'validator.ts'), 'type PagesPageConfig = {};');

    return dir;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pp-dev-next-types-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('removes <distDir>/dev/types for a static export with a custom distDir', () => {
    const dir = seedDevTypes('dist');
    writeFileSync(join(root, 'dist', 'index.html'), '<html></html>');

    expect(removeStaleDevTypes(root, { output: 'export', distDir: 'dist' })).toBe(dir);
    expect(existsSync(dir)).toBe(false);
    // Only the generated dev types go — the rest of distDir is untouched.
    expect(existsSync(join(root, 'dist', 'index.html'))).toBe(true);
  });

  it('does nothing when the dev types directory does not exist', () => {
    expect(removeStaleDevTypes(root, { output: 'export', distDir: 'dist' })).toBeNull();
  });

  it('leaves the default .next distDir to Next (it already filters .next/dev/types)', () => {
    const dir = seedDevTypes('.next');

    expect(removeStaleDevTypes(root, { output: 'export', distDir: '.next' })).toBeNull();
    expect(existsSync(dir)).toBe(true);
  });

  it('leaves non-export builds alone', () => {
    const dir = seedDevTypes('dist');

    expect(removeStaleDevTypes(root, { distDir: 'dist' })).toBeNull();
    expect(removeStaleDevTypes(root, undefined)).toBeNull();
    expect(existsSync(dir)).toBe(true);
  });
});
