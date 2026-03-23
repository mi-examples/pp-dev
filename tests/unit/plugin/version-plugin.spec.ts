import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import type { Plugin } from 'vite';
import { versionPlugin } from '../../../src/plugins/version-plugin.js';

function invokeCloseBundle(plugin: Plugin) {
  const hook = plugin.closeBundle;

  if (!hook) {
    return;
  }

  if (typeof hook === 'function') {
    (hook as (this: unknown) => void).call(undefined);
  } else if (typeof hook === 'object' && hook !== null && 'handler' in hook) {
    const { handler } = hook as {
      handler: (this: unknown) => void | Promise<void>;
    };

    if (typeof handler === 'function') {
      handler.call(undefined);
    }
  }
}

describe('versionPlugin', () => {
  let tempDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pp-dev-version-test-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('closeBundle', () => {
    it('should create VERSION JSON with version, date, checksum, and files', () => {
      const outDir = join(tempDir, 'dist');

      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'index.html'), '<html>test</html>', 'utf-8');
      writeFileSync(join(outDir, 'asset.js'), 'console.log("hi");', 'utf-8');

      const plugin = versionPlugin({
        outDir,
        packageVersion: '1.2.3',
      });

      invokeCloseBundle(plugin);

      const versionFile = join(outDir, 'VERSION-v1.2.3-');
      const files = require('fs').readdirSync(outDir);
      const versionFilename = files.find(
        (f: string) => f.startsWith('VERSION-') && f.endsWith('.json'),
      );

      expect(versionFilename).toBeDefined();

      const manifest = JSON.parse(
        readFileSync(join(outDir, versionFilename!), 'utf-8'),
      );

      expect(manifest.version).toBe('v1.2.3');
      expect(manifest.date).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
      expect(manifest.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.files).toHaveProperty('index.html');
      expect(manifest.files).toHaveProperty('asset.js');
      expect(manifest.files['index.html']).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.files['asset.js']).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should hash file content only (deterministic for same content)', () => {
      const outDir = join(tempDir, 'dist');
      mkdirSync(outDir, { recursive: true });
      const content = 'identical content';
      writeFileSync(join(outDir, 'a.txt'), content, 'utf-8');
      writeFileSync(join(outDir, 'b.txt'), content, 'utf-8');

      const expectedHash = createHash('sha256')
        .update(content, 'utf-8')
        .digest('hex');

      const plugin = versionPlugin({ outDir, packageVersion: '1.0.0' });

      invokeCloseBundle(plugin);

      const files = require('fs').readdirSync(outDir);
      const versionFilename = files.find(
        (f: string) => f.startsWith('VERSION-') && f.endsWith('.json'),
      );
      const manifest = JSON.parse(
        readFileSync(join(outDir, versionFilename!), 'utf-8'),
      );

      expect(manifest.files['a.txt']).toBe(expectedHash);
      expect(manifest.files['b.txt']).toBe(expectedHash);
    });

    it('should produce deterministic checksum for same file set', () => {
      const outDir = join(tempDir, 'dist');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'f1.js'), 'a', 'utf-8');
      writeFileSync(join(outDir, 'f2.js'), 'b', 'utf-8');

      const plugin = versionPlugin({ outDir, packageVersion: '1.0.0' });

      invokeCloseBundle(plugin);

      const files = require('fs').readdirSync(outDir);
      const versionFilename = files.find(
        (f: string) => f.startsWith('VERSION-') && f.endsWith('.json'),
      );
      const manifest1 = JSON.parse(
        readFileSync(join(outDir, versionFilename!), 'utf-8'),
      );

      rmSync(join(outDir, versionFilename!));
      invokeCloseBundle(plugin);

      const filesAfter = require('fs').readdirSync(outDir);
      const versionFilename2 = filesAfter.find(
        (f: string) => f.startsWith('VERSION-') && f.endsWith('.json'),
      );
      const manifest2 = JSON.parse(
        readFileSync(join(outDir, versionFilename2!), 'utf-8'),
      );

      expect(manifest1.checksum).toBe(manifest2.checksum);
    });

    it('should use custom versionFileTemplate when provided', () => {
      const outDir = join(tempDir, 'dist');

      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'x'), 'x', 'utf-8');

      const plugin = versionPlugin({
        outDir,
        packageVersion: '2.0.0-beta',
        versionFileTemplate: 'manifest-{packageversion}-{currentDate}.json',
      });

      invokeCloseBundle(plugin);

      const files = require('fs').readdirSync(outDir);
      const manifestFilename = files.find(
        (f: string) =>
          f.startsWith('manifest-2.0.0-beta-') && f.endsWith('.json'),
      );
      expect(manifestFilename).toBeDefined();
      const manifest = JSON.parse(
        readFileSync(join(outDir, manifestFilename!), 'utf-8'),
      );

      expect(manifest.version).toBe('v2.0.0-beta');
    });

    it('should not run when enabled is false', () => {
      const outDir = join(tempDir, 'dist');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'test.txt'), 'test', 'utf-8');

      const plugin = versionPlugin({
        outDir,
        packageVersion: '1.0.0',
        enabled: false,
      });

      invokeCloseBundle(plugin);

      const files = require('fs').readdirSync(outDir);
      const versionFile = files.find(
        (f: string) => f.includes('VERSION') || f.includes('manifest'),
      );

      expect(versionFile).toBeUndefined();
    });

    it('should include files in subdirectories', () => {
      const outDir = join(tempDir, 'dist');

      mkdirSync(join(outDir, 'assets', 'nested'), { recursive: true });
      writeFileSync(join(outDir, 'index.html'), 'x', 'utf-8');
      writeFileSync(join(outDir, 'assets', 'style.css'), 'body{}', 'utf-8');
      writeFileSync(
        join(outDir, 'assets', 'nested', 'script.js'),
        '()=>{}',
        'utf-8',
      );

      const plugin = versionPlugin({ outDir, packageVersion: '1.0.0' });

      invokeCloseBundle(plugin);

      const files = require('fs').readdirSync(outDir);
      const versionFilename = files.find(
        (f: string) => f.startsWith('VERSION-') && f.endsWith('.json'),
      );
      const manifest = JSON.parse(
        readFileSync(join(outDir, versionFilename!), 'utf-8'),
      );

      expect(manifest.files).toHaveProperty('index.html');
      expect(manifest.files).toHaveProperty('assets/style.css');
      expect(manifest.files).toHaveProperty('assets/nested/script.js');
    });

    it('should exclude the version file itself from the files map', () => {
      const outDir = join(tempDir, 'dist');

      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'only.txt'), 'only', 'utf-8');

      const plugin = versionPlugin({ outDir, packageVersion: '1.0.0' });

      invokeCloseBundle(plugin);

      const files = require('fs').readdirSync(outDir);
      const versionFilename = files.find(
        (f: string) => f.startsWith('VERSION-') && f.endsWith('.json'),
      );
      const manifest = JSON.parse(
        readFileSync(join(outDir, versionFilename!), 'utf-8'),
      );

      expect(Object.keys(manifest.files)).not.toContain(versionFilename);
      expect(Object.keys(manifest.files)).toEqual(['only.txt']);
    });

    it('should return early when outDir does not exist', () => {
      const outDir = join(tempDir, 'nonexistent');

      expect(existsSync(outDir)).toBe(false);

      const plugin = versionPlugin({ outDir, packageVersion: '1.0.0' });

      expect(() => invokeCloseBundle(plugin)).not.toThrow();

      expect(existsSync(outDir)).toBe(false);
    });
  });

  describe('plugin metadata', () => {
    it('should have correct name, apply, and enforce', () => {
      const plugin = versionPlugin({
        outDir: 'dist',
        packageVersion: '1.0.0',
      });

      expect(plugin.name).toBe('pp-dev-version');
      expect(plugin.apply).toBe('build');
      expect(plugin.enforce).toBe('post');
    });
  });
});
