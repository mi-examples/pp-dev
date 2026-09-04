import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isLegacyFlatConfig,
  isLegacyPPWatchConfig,
  isAlreadyMigrated,
  migrateLegacyFlatConfig,
  migratePPWatchConfig,
  generateConfigFileContent,
  discoverMigrateSource,
  loadPackageJsonMigrateConfig,
} from '../../../src/lib/migrate.js';

describe('migrate — detection', () => {
  it('detects legacy flat config', () => {
    expect(isLegacyFlatConfig({ backendBaseURL: 'https://x', appId: 1 })).toBe(true);
    expect(isLegacyFlatConfig({ portalPageId: 1, templateLess: false })).toBe(true);
    expect(isLegacyFlatConfig({ miHudLess: true })).toBe(true);
  });

  it('detects pp-watch config', () => {
    expect(isLegacyPPWatchConfig({ baseURL: 'https://x', portalPageId: 5 })).toBe(true);
    expect(isLegacyPPWatchConfig({ backendBaseURL: 'https://x' })).toBe(false);
  });

  it('detects already-migrated config', () => {
    expect(isAlreadyMigrated({ mi: { url: 'https://x' } })).toBe(true);
    expect(isAlreadyMigrated({ app: { id: 1 } })).toBe(true);
    expect(isAlreadyMigrated({ backendBaseURL: 'https://x' })).toBe(false);
  });
});

describe('migrate — migrateLegacyFlatConfig', () => {
  it('maps backendBaseURL → mi.url and token', () => {
    const result = migrateLegacyFlatConfig({ backendBaseURL: 'https://mi.co', personalAccessToken: 'tok' });
    expect(result.mi?.url).toBe('https://mi.co');
    expect(result.mi?.token).toBe('tok');
  });

  it('maps miHudLess: true → mi.mode: standalone', () => {
    expect(migrateLegacyFlatConfig({ miHudLess: true }).mi?.mode).toBe('standalone');
    expect(migrateLegacyFlatConfig({ miHudLess: false }).mi?.mode).toBe('embedding');
  });

  it('maps integrateMiTopBar: true → mi.include: top-bar + forces standalone', () => {
    const result = migrateLegacyFlatConfig({ integrateMiTopBar: true });
    expect(result.mi?.mode).toBe('standalone');
    expect(result.mi?.include).toBe('top-bar');
  });

  it('maps integrateMiTopBar object', () => {
    const result = migrateLegacyFlatConfig({
      integrateMiTopBar: { addSharedComponentsScripts: true, addRootElement: false },
    });
    expect(result.mi?.include).toBe('shared-components');
  });

  it('maps v7Features → mi.apiVersion', () => {
    expect(migrateLegacyFlatConfig({ v7Features: true }).mi?.apiVersion).toBe(7);
    expect(migrateLegacyFlatConfig({ v7Features: false }).mi?.apiVersion).toBe(6);
  });

  it('prefers appId over portalPageId', () => {
    expect(migrateLegacyFlatConfig({ appId: 10, portalPageId: 99 }).app?.id).toBe(10);
    expect(migrateLegacyFlatConfig({ portalPageId: 5 }).app?.id).toBe(5);
  });

  it('maps templateLess → app.type', () => {
    expect(migrateLegacyFlatConfig({ templateLess: true }).app?.type).toBe('page');
    expect(migrateLegacyFlatConfig({ templateLess: false }).app?.type).toBe('template');
  });

  it('skips templateName if it matches packageName', () => {
    const result = migrateLegacyFlatConfig({ templateName: 'my-app' }, 'my-app');
    expect(result.app?.name).toBeUndefined();
  });

  it('keeps templateName if it differs from packageName', () => {
    const result = migrateLegacyFlatConfig({ templateName: 'custom-name' }, 'my-app');
    expect(result.app?.name).toBe('custom-name');
  });

  it('maps proxy fields', () => {
    const result = migrateLegacyFlatConfig({ enableProxyCache: false, proxyCacheTTL: 30000, disableSSLValidation: true });
    expect(result.proxy?.cache).toBe(false);
    expect(result.proxy?.cacheTtl).toBe(30000);
    expect(result.proxy?.tls?.allowSelfSigned).toBe(true);
  });

  it('maps build fields', () => {
    const result = migrateLegacyFlatConfig({
      outDir: 'build',
      distZip: { outFileName: 'app.zip', outDir: 'zips' },
      versionPlugin: { versionFileTemplate: 'V-{packageversion}.json', enabled: true },
      imageOptimizer: true,
    });
    expect(result.build?.outDir).toBe('build');
    expect(result.build?.zip).toEqual({ fileName: 'app.zip', outDir: 'zips' });
    expect(result.build?.versionFile).toEqual({ fileNameTemplate: 'V-{packageversion}.json', enabled: true });
    expect(result.build?.imageOptimisations).toBe(true);
  });

  it('maps build.zip: false', () => {
    expect(migrateLegacyFlatConfig({ distZip: false }).build?.zip).toBe(false);
  });

  it('maps sync.backupsDir', () => {
    expect(migrateLegacyFlatConfig({ syncBackupsDir: 'my-backups' }).sync?.backupsDir).toBe('my-backups');
  });

  it('produces empty groups only when needed', () => {
    const result = migrateLegacyFlatConfig({ appId: 42 });
    expect(result.mi).toBeUndefined();
    expect(result.proxy).toBeUndefined();
    expect(result.build).toBeUndefined();
    expect(result.sync).toBeUndefined();
    expect(result.app?.id).toBe(42);
  });
});

describe('migrate — migratePPWatchConfig', () => {
  it('maps baseURL → mi.url and portalPageId → app.id', () => {
    const result = migratePPWatchConfig({ baseURL: 'https://mi.co', portalPageId: 7 });
    expect(result.mi?.url).toBe('https://mi.co');
    expect(result.app?.id).toBe(7);
  });

  it('works without portalPageId', () => {
    const result = migratePPWatchConfig({ baseURL: 'https://mi.co' });
    expect(result.app).toBeUndefined();
  });
});

describe('migrate — generateConfigFileContent', () => {
  const config = { mi: { url: 'https://mi.co', mode: 'standalone' as const }, app: { id: 42, type: 'template' as const } };

  it('generates TS output with defineConfig import', () => {
    const out = generateConfigFileContent(config, 'ts');
    expect(out).toContain(`import { defineConfig } from '@metricinsights/pp-dev'`);
    expect(out).toContain('export default defineConfig(');
    expect(out).toContain(`url: 'https://mi.co'`);
    expect(out).toContain('id: 42');
  });

  it('generates JS output with require', () => {
    const out = generateConfigFileContent(config, 'js');
    expect(out).toContain(`require('@metricinsights/pp-dev')`);
    expect(out).toContain('module.exports =');
  });

  it('generates JSON output', () => {
    const out = generateConfigFileContent(config, 'json');
    const parsed = JSON.parse(out);
    expect(parsed.mi.url).toBe('https://mi.co');
    expect(parsed.app.id).toBe(42);
  });
});

describe('migrate — discoverMigrateSource', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `pp-dev-migrate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('returns null when nothing to migrate is found', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test' }));

    expect(discoverMigrateSource(testDir)).toBeNull();
  });

  it('falls back to the `pp-dev` field in package.json when no dedicated config file exists', () => {
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({ name: 'test', 'pp-dev': { backendBaseURL: 'https://pkg.example.com' } }),
    );

    const result = discoverMigrateSource(testDir);

    expect(result).toEqual({
      sourceFile: join(testDir, 'package.json'),
      isWatchConfig: false,
      isPackageJsonConfig: true,
    });
  });

  it('ignores package.json when it has no `pp-dev` field', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test', 'pp-dev': undefined }));

    expect(discoverMigrateSource(testDir)).toBeNull();
  });

  it('ignores a non-object `pp-dev` field in package.json', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test', 'pp-dev': './pp-dev.config.js' }));

    expect(discoverMigrateSource(testDir)).toBeNull();
  });

  it('ignores an array `pp-dev` field in package.json', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test', 'pp-dev': ['a', 'b'] }));

    expect(discoverMigrateSource(testDir)).toBeNull();
  });

  it('does not throw when package.json is invalid JSON', () => {
    writeFileSync(join(testDir, 'package.json'), '{ not valid json');

    expect(discoverMigrateSource(testDir)).toBeNull();
  });

  it('prefers a dedicated pp-dev.config.json over the package.json field', () => {
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({ name: 'test', 'pp-dev': { backendBaseURL: 'https://pkg.example.com' } }),
    );
    writeFileSync(join(testDir, 'pp-dev.config.json'), JSON.stringify({ backendBaseURL: 'https://file.example.com' }));

    const result = discoverMigrateSource(testDir);

    expect(result?.sourceFile).toBe(join(testDir, 'pp-dev.config.json'));
    expect(result?.isPackageJsonConfig).toBe(false);
  });

  it('prefers a legacy pp-watch config file over the package.json field', () => {
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({ name: 'test', 'pp-dev': { backendBaseURL: 'https://pkg.example.com' } }),
    );
    writeFileSync(join(testDir, 'pp-watch.config.json'), JSON.stringify({ baseURL: 'https://watch.example.com' }));

    const result = discoverMigrateSource(testDir);

    expect(result?.sourceFile).toBe(join(testDir, 'pp-watch.config.json'));
    expect(result?.isWatchConfig).toBe(true);
    expect(result?.isPackageJsonConfig).toBe(false);
  });

  it('respects an explicit config path even when it is package.json', () => {
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({ name: 'test', 'pp-dev': { backendBaseURL: 'https://pkg.example.com' } }),
    );

    const explicitPath = join(testDir, 'package.json');
    const result = discoverMigrateSource(testDir, explicitPath);

    expect(result).toEqual({
      sourceFile: explicitPath,
      isWatchConfig: false,
      isPackageJsonConfig: true,
    });
  });

  it('does not fall back to package.json when an explicit non-existent path is given', () => {
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({ name: 'test', 'pp-dev': { backendBaseURL: 'https://pkg.example.com' } }),
    );

    const explicitPath = join(testDir, 'does-not-exist.config.json');
    const result = discoverMigrateSource(testDir, explicitPath);

    // An explicit arg is trusted as-is — no fallback scan happens
    expect(result).toEqual({
      sourceFile: explicitPath,
      isWatchConfig: false,
      isPackageJsonConfig: false,
    });
  });
});

describe('migrate — loadPackageJsonMigrateConfig', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `pp-dev-migrate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('reads only the `pp-dev` field, not the whole package.json', () => {
    const pkgJsonPath = join(testDir, 'package.json');

    writeFileSync(
      pkgJsonPath,
      JSON.stringify({
        name: 'test',
        version: '1.0.0',
        'pp-dev': { backendBaseURL: 'https://pkg.example.com', appId: 7 },
      }),
    );

    expect(loadPackageJsonMigrateConfig(pkgJsonPath)).toEqual({
      backendBaseURL: 'https://pkg.example.com',
      appId: 7,
    });
  });

  it('returns undefined when there is no `pp-dev` field', () => {
    const pkgJsonPath = join(testDir, 'package.json');

    writeFileSync(pkgJsonPath, JSON.stringify({ name: 'test' }));

    expect(loadPackageJsonMigrateConfig(pkgJsonPath)).toBeUndefined();
  });
});
