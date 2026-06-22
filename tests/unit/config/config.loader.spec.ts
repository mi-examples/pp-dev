import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Config Loader', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();

    testDir = join(tmpdir(), `pp-dev-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });

    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);

    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }

    vi.resetModules();
  });

  describe('getConfig', () => {
    it('should return empty config when no config files exist', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test' }));

      const { getConfig, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const config = await getConfig();

      expect(config).toEqual({});
    });

    it('should load grouped config from package.json pp-dev field', async () => {
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({
          name: 'test-project',
          'pp-dev': {
            mi: { url: 'https://pkg.example.com' },
            app: { id: 456 },
          },
        }),
      );

      const { getConfig, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const config = await getConfig();

      expect(config.mi?.url).toBe('https://pkg.example.com');
      expect(config.app?.id).toBe(456);
    });

    it('should load grouped config from pp-dev.config.json', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test' }));
      writeFileSync(
        join(testDir, 'pp-dev.config.json'),
        JSON.stringify({
          mi: { url: 'https://json.example.com' },
          app: { id: 111, type: 'page' },
        }),
      );

      const { getConfig, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const config = await getConfig();

      expect(config.mi?.url).toBe('https://json.example.com');
      expect(config.app?.id).toBe(111);
      expect(config.app?.type).toBe('page');
    });

    it('should prioritize config file over package.json pp-dev field', async () => {
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({
          name: 'test',
          'pp-dev': {
            mi: { url: 'https://pkg.example.com' },
            app: { id: 1 },
          },
        }),
      );
      writeFileSync(
        join(testDir, 'pp-dev.config.json'),
        JSON.stringify({
          mi: { url: 'https://file.example.com' },
          app: { id: 2 },
        }),
      );

      const { getConfig, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const config = await getConfig();

      expect(config.mi?.url).toBe('https://file.example.com');
      expect(config.app?.id).toBe(2);
    });

    it('should not load pp-watch.config.json (legacy format removed in 1.0)', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test' }));
      writeFileSync(
        join(testDir, '.pp-watch.config.json'),
        JSON.stringify({
          baseURL: 'https://watch.example.com',
          portalPageId: 789,
        }),
      );

      const { getConfig, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const config = await getConfig();

      // Legacy watch config is no longer loaded — result should be empty
      expect(config).toEqual({});
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
        }),
      );

      const { getPkg, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const pkg = getPkg();

      expect(pkg.name).toBe('test-package');
      expect(pkg.version).toBe('1.0.0');
    });

    it('should return empty object when package.json does not exist', async () => {
      const { getPkg, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const pkg = getPkg();

      expect(pkg).toEqual({});
    });
  });

  describe('Config Caching', () => {
    it('should cache package.json reads', async () => {
      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0' }));

      const { getPkg, clearConfigCache } = await import('../../../src/config.js');
      clearConfigCache();

      const pkg1 = getPkg();
      const pkg2 = getPkg();

      expect(pkg1).toBe(pkg2); // same cached reference on second call
    });

    it('should clear cache when clearConfigCache is called', async () => {
      const { getPkg, clearConfigCache } = await import('../../../src/config.js');

      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'before-clear' }));
      clearConfigCache();
      expect(getPkg().name).toBe('before-clear');

      writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'after-clear' }));
      clearConfigCache();
      expect(getPkg().name).toBe('after-clear');
    });
  });
});
