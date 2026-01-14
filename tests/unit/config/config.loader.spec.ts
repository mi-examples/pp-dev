import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Config Loader', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    // Save original cwd
    originalCwd = process.cwd();

    // Create a unique test directory
    testDir = join(tmpdir(), `pp-dev-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });

    // Change to test directory
    process.chdir(testDir);
  });

  afterEach(async () => {
    // Restore original cwd
    process.chdir(originalCwd);

    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }

    // Clear module cache to ensure fresh imports
    vi.resetModules();
  });

  describe('getConfig', () => {
    it('should return empty config when no config files exist', async () => {
      // Create minimal package.json
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test' }));

      const { getConfig, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const config = await getConfig();

      expect(config).toEqual({});
    });

    it('should load config from package.json pp-dev field', async () => {
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({
          name: 'test-project',
          'pp-dev': {
            backendBaseURL: 'https://pkg.example.com',
            portalPageId: 456,
          },
        })
      );

      const { getConfig, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const config = await getConfig();

      expect(config.backendBaseURL).toBe('https://pkg.example.com');
      expect(config.portalPageId).toBe(456);
    });

    it('should load config from .pp-watch.config.json (legacy format)', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test' }));
      writeFileSync(
        join(testDir, '.pp-watch.config.json'),
        JSON.stringify({
          baseURL: 'https://watch.example.com',
          portalPageId: 789,
        })
      );

      const { getConfig, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const config = await getConfig();

      expect(config.backendBaseURL).toBe('https://watch.example.com');
      expect(config.portalPageId).toBe(789);
    });

    it('should load config from pp-dev.config.json', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test' }));
      writeFileSync(
        join(testDir, 'pp-dev.config.json'),
        JSON.stringify({
          backendBaseURL: 'https://json.example.com',
          portalPageId: 111,
          templateLess: true,
        })
      );

      const { getConfig, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const config = await getConfig();

      expect(config.backendBaseURL).toBe('https://json.example.com');
      expect(config.portalPageId).toBe(111);
      expect(config.templateLess).toBe(true);
    });

    it('should prioritize pp-dev config over pp-watch config', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test' }));

      // Create both configs
      writeFileSync(
        join(testDir, 'pp-dev.config.json'),
        JSON.stringify({
          backendBaseURL: 'https://pp-dev.example.com',
          portalPageId: 100,
        })
      );
      writeFileSync(
        join(testDir, '.pp-watch.config.json'),
        JSON.stringify({
          baseURL: 'https://pp-watch.example.com',
          portalPageId: 200,
        })
      );

      const { getConfig, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const config = await getConfig();

      // pp-dev config should take priority
      expect(config.backendBaseURL).toBe('https://pp-dev.example.com');
      expect(config.portalPageId).toBe(100);
    });

    it('should prioritize config file over package.json pp-dev field', async () => {
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({
          name: 'test',
          'pp-dev': {
            backendBaseURL: 'https://pkg.example.com',
            portalPageId: 1,
          },
        })
      );
      writeFileSync(
        join(testDir, 'pp-dev.config.json'),
        JSON.stringify({
          backendBaseURL: 'https://file.example.com',
          portalPageId: 2,
        })
      );

      const { getConfig, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const config = await getConfig();

      // Config file should take priority
      expect(config.backendBaseURL).toBe('https://file.example.com');
      expect(config.portalPageId).toBe(2);
    });
  });

  describe('getPkg', () => {
    it('should return package.json contents', async () => {
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({
          name: 'test-package',
          version: '1.0.0',
          description: 'Test package',
        })
      );

      const { getPkg, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const pkg = getPkg();

      expect(pkg.name).toBe('test-package');
      expect(pkg.version).toBe('1.0.0');
    });

    it('should return empty object when package.json does not exist', async () => {
      // Don't create package.json

      const { getPkg, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const pkg = getPkg();

      expect(pkg).toEqual({});
    });
  });

  describe('Config Caching', () => {
    it('should cache package.json reads', async () => {
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({ name: 'test', version: '1.0.0' })
      );

      const { getPkg, clearConfigCache, getConfigCacheStats } = await import('../../../src/config.js');
      clearConfigCache();

      // First call
      getPkg();
      const stats1 = getConfigCacheStats();

      // Second call (should use cache)
      getPkg();
      const stats2 = getConfigCacheStats();

      expect(stats1.packageJsonCached).toBe(true);
      expect(stats2.packageJsonCached).toBe(true);
    });

    it('should clear cache when clearConfigCache is called', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test' }));

      const { getPkg, clearConfigCache, getConfigCacheStats } = await import('../../../src/config.js');

      // Populate cache
      getPkg();
      expect(getConfigCacheStats().packageJsonCached).toBe(true);

      // Clear cache
      clearConfigCache();
      expect(getConfigCacheStats().packageJsonCached).toBe(false);
      expect(getConfigCacheStats().configEntries).toBe(0);
      expect(getConfigCacheStats().dirContentCached).toBe(false);
    });
  });
});
