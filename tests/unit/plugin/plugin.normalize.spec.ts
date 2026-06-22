import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizePPDevConfig, validatePPDevConfig, type PPDevConfig } from '../../../src/plugin.js';

describe('normalizePPDevConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.MI_BACKEND_URL;
    delete process.env.MI_ACCESS_TOKEN;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Default values', () => {
    it('defaults mi.mode=standalone → miHudLess=true', () => {
      const n = normalizePPDevConfig({}, 'my-app');
      expect(n.miHudLess).toBe(true);
    });

    it('defaults app.type=template → templateLess=false', () => {
      const n = normalizePPDevConfig({}, 'my-app');
      expect(n.templateLess).toBe(false);
    });

    it('defaults mi.apiVersion=7 → v7Features=true', () => {
      const n = normalizePPDevConfig({}, 'my-app');
      expect(n.v7Features).toBe(true);
    });

    it('defaults proxy.cache=true → enableProxyCache=true', () => {
      const n = normalizePPDevConfig({}, 'my-app');
      expect(n.enableProxyCache).toBe(true);
    });

    it('defaults proxy.cacheTtl=600000 → proxyCacheTTL=600000', () => {
      const n = normalizePPDevConfig({}, 'my-app');
      expect(n.proxyCacheTTL).toBe(600_000);
    });

    it('defaults proxy.tls.allowSelfSigned=false → disableSSLValidation=false', () => {
      const n = normalizePPDevConfig({}, 'my-app');
      expect(n.disableSSLValidation).toBe(false);
    });

    it('defaults build.outDir=dist', () => {
      const n = normalizePPDevConfig({}, 'my-app');
      expect(n.outDir).toBe('dist');
    });

    it('defaults sync.backupsDir=backups', () => {
      const n = normalizePPDevConfig({}, 'my-app');
      expect(n.syncBackupsDir).toBe('backups');
    });

    it('defaults mi.include=undefined → integrateMiTopBar=false', () => {
      const n = normalizePPDevConfig({}, 'my-app');
      expect(n.integrateMiTopBar).toBe(false);
    });

    it('uses templateName as fallback for templateName field', () => {
      const n = normalizePPDevConfig({}, 'my-app');
      expect(n.templateName).toBe('my-app');
    });

    it('app.name overrides templateName param', () => {
      const n = normalizePPDevConfig({ app: { name: 'custom-name' } }, 'my-app');
      expect(n.templateName).toBe('custom-name');
    });
  });

  describe('mi.mode mapping', () => {
    it('standalone → miHudLess=true', () => {
      const n = normalizePPDevConfig({ mi: { mode: 'standalone' } }, 'app');
      expect(n.miHudLess).toBe(true);
    });

    it('embedding → miHudLess=false', () => {
      const n = normalizePPDevConfig({ mi: { mode: 'embedding' } }, 'app');
      expect(n.miHudLess).toBe(false);
    });
  });

  describe('mi.include mapping', () => {
    it('top-bar → integrateMiTopBar=true', () => {
      const n = normalizePPDevConfig({ mi: { mode: 'standalone', include: 'top-bar' } }, 'app');
      expect(n.integrateMiTopBar).toBe(true);
    });

    it('shared-components → integrateMiTopBar object', () => {
      const n = normalizePPDevConfig({ mi: { mode: 'standalone', include: 'shared-components' } }, 'app');
      expect(n.integrateMiTopBar).toEqual({ addSharedComponentsScripts: true, addRootElement: false });
    });
  });

  describe('app.type mapping', () => {
    it('page → templateLess=true', () => {
      const n = normalizePPDevConfig({ app: { type: 'page' } }, 'app');
      expect(n.templateLess).toBe(true);
    });

    it('template → templateLess=false', () => {
      const n = normalizePPDevConfig({ app: { type: 'template' } }, 'app');
      expect(n.templateLess).toBe(false);
    });
  });

  describe('mi.apiVersion mapping', () => {
    it('apiVersion=7 → v7Features=true', () => {
      const n = normalizePPDevConfig({ mi: { apiVersion: 7 } }, 'app');
      expect(n.v7Features).toBe(true);
    });

    it('apiVersion=6 → v7Features=false', () => {
      const n = normalizePPDevConfig({ mi: { apiVersion: 6 } }, 'app');
      expect(n.v7Features).toBe(false);
    });
  });

  describe('app.id mapping', () => {
    it('app.id → appId', () => {
      const n = normalizePPDevConfig({ app: { id: 123 } }, 'app');
      expect(n.appId).toBe(123);
    });

    it('no app.id → appId=undefined', () => {
      const n = normalizePPDevConfig({}, 'app');
      expect(n.appId).toBeUndefined();
    });
  });

  describe('mi.url / mi.token mapping', () => {
    it('mi.url → backendBaseURL', () => {
      const n = normalizePPDevConfig({ mi: { url: 'https://mi.example.com' } }, 'app');
      expect(n.backendBaseURL).toBe('https://mi.example.com');
    });

    it('falls back to MI_BACKEND_URL env', () => {
      process.env.MI_BACKEND_URL = 'https://env.example.com';
      const n = normalizePPDevConfig({}, 'app');
      expect(n.backendBaseURL).toBe('https://env.example.com');
    });

    it('mi.token → personalAccessToken', () => {
      const n = normalizePPDevConfig({ mi: { token: 'my-token' } }, 'app');
      expect(n.personalAccessToken).toBe('my-token');
    });

    it('falls back to MI_ACCESS_TOKEN env', () => {
      process.env.MI_ACCESS_TOKEN = 'env-token';
      const n = normalizePPDevConfig({}, 'app');
      expect(n.personalAccessToken).toBe('env-token');
    });

    it('explicit token takes precedence over env', () => {
      process.env.MI_ACCESS_TOKEN = 'env-token';
      const n = normalizePPDevConfig({ mi: { token: 'explicit' } }, 'app');
      expect(n.personalAccessToken).toBe('explicit');
    });
  });

  describe('build.zip normalization', () => {
    it('zip=true → distZip object with defaults', () => {
      const n = normalizePPDevConfig({ build: { zip: true } }, 'my-app');
      expect(n.distZip).toEqual({ outFileName: 'my-app.zip', outDir: 'dist-zip' });
    });

    it('zip=false → distZip=false', () => {
      const n = normalizePPDevConfig({ build: { zip: false } }, 'my-app');
      expect(n.distZip).toBe(false);
    });

    it('zip omitted → distZip object with defaults', () => {
      const n = normalizePPDevConfig({}, 'my-app');
      expect(n.distZip).toEqual({ outFileName: 'my-app.zip', outDir: 'dist-zip' });
    });

    it('zip object with custom fileName', () => {
      const n = normalizePPDevConfig({ build: { zip: { fileName: 'custom.zip', outDir: 'release' } } }, 'my-app');
      expect(n.distZip).toEqual({ outFileName: 'custom.zip', outDir: 'release' });
    });

    it('zip object uses app.name in default zip filename', () => {
      const n = normalizePPDevConfig({ app: { name: 'custom-name' }, build: { zip: true } }, 'fallback');
      expect((n.distZip as any).outFileName).toBe('custom-name.zip');
    });
  });

  describe('build.versionFile normalization', () => {
    it('versionFile=false → versionPlugin=false', () => {
      const n = normalizePPDevConfig({ build: { versionFile: false } }, 'app');
      expect(n.versionPlugin).toBe(false);
    });

    it('versionFile=true → versionPlugin object with defaults', () => {
      const n = normalizePPDevConfig({ build: { versionFile: true } }, 'app');
      expect(n.versionPlugin).toMatchObject({ enabled: true });
    });

    it('versionFile object passes through options', () => {
      const n = normalizePPDevConfig(
        { build: { versionFile: { fileNameTemplate: 'CUSTOM.json', enabled: false } } },
        'app',
      );
      expect(n.versionPlugin).toEqual({ versionFileTemplate: 'CUSTOM.json', enabled: false });
    });
  });

  describe('build.imageOptimisations normalization', () => {
    it('imageOptimisations=false → imageOptimizer=false', () => {
      const n = normalizePPDevConfig({ build: { imageOptimisations: false } }, 'app');
      expect(n.imageOptimizer).toBe(false);
    });

    it('imageOptimisations=true → imageOptimizer={}', () => {
      const n = normalizePPDevConfig({ build: { imageOptimisations: true } }, 'app');
      expect(n.imageOptimizer).toEqual({});
    });

    it('imageOptimisations object is passed through', () => {
      const opts = { png: { quality: 80 } };
      const n = normalizePPDevConfig({ build: { imageOptimisations: opts } }, 'app');
      expect(n.imageOptimizer).toEqual(opts);
    });
  });

  describe('Complete configuration', () => {
    it('normalizes a full config correctly', () => {
      const config: PPDevConfig = {
        mi: { url: 'https://mi.example.com', mode: 'standalone', include: 'top-bar', apiVersion: 7, token: 'tok' },
        app: { id: 42, type: 'template', name: 'my-template' },
        proxy: { cache: false, cacheTtl: 120_000, tls: { allowSelfSigned: true } },
        build: { outDir: 'build', zip: false, versionFile: false, imageOptimisations: false },
        sync: { backupsDir: 'archives' },
      };

      const n = normalizePPDevConfig(config, 'fallback');

      expect(n).toMatchObject({
        templateName: 'my-template',
        backendBaseURL: 'https://mi.example.com',
        appId: 42,
        templateLess: false,
        miHudLess: true,
        integrateMiTopBar: true,
        enableProxyCache: false,
        proxyCacheTTL: 120_000,
        disableSSLValidation: true,
        imageOptimizer: false,
        outDir: 'build',
        distZip: false,
        versionPlugin: false,
        syncBackupsDir: 'archives',
        v7Features: true,
        personalAccessToken: 'tok',
      });
    });
  });
});

describe('validatePPDevConfig', () => {
  it('throws if templateName is empty', () => {
    expect(() => validatePPDevConfig({}, '')).toThrow('app.name is required');
  });

  it('throws if mi.include is set with embedding mode', () => {
    expect(() =>
      validatePPDevConfig({ mi: { mode: 'embedding', include: 'top-bar' } }, 'app'),
    ).toThrow('mi.include requires mi.mode to be "standalone"');
  });

  it('throws if mi.url missing + mode=embedding', () => {
    expect(() => validatePPDevConfig({ mi: { mode: 'embedding' } }, 'app')).toThrow('mi.url is required');
  });

  it('throws if mi.url missing + app.type=template', () => {
    expect(() => validatePPDevConfig({ app: { type: 'template', id: 1 } }, 'app')).toThrow('mi.url is required');
  });

  it('warns (does not throw) if mi.url missing + standalone + page', () => {
    expect(() => validatePPDevConfig({ mi: { mode: 'standalone' }, app: { type: 'page', id: 1 } }, 'app')).not.toThrow();
  });

  it('throws if app.type=template without app.id', () => {
    expect(() =>
      validatePPDevConfig({ mi: { url: 'https://mi.example.com' }, app: { type: 'template' } }, 'app'),
    ).toThrow('app.id is required when app.type is "template"');
  });

  it('throws if app.type=page + standalone without app.id', () => {
    expect(() =>
      validatePPDevConfig(
        { mi: { url: 'https://mi.example.com', mode: 'standalone' }, app: { type: 'page' } },
        'app',
      ),
    ).toThrow('app.id is required when app.type is "page" and mi.mode is "standalone"');
  });

  it('passes valid standalone template config', () => {
    expect(() =>
      validatePPDevConfig(
        { mi: { url: 'https://mi.example.com', mode: 'standalone' }, app: { type: 'template', id: 1 } },
        'app',
      ),
    ).not.toThrow();
  });
});
