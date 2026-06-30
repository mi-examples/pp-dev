import type { PPDevConfig } from '../plugin.js';

// ─── Legacy config shapes ─────────────────────────────────────────────────────

export interface LegacyFlatConfig {
  backendBaseURL?: string;
  personalAccessToken?: string;
  miHudLess?: boolean;
  integrateMiTopBar?: boolean | { addRootElement?: boolean; addSharedComponentsScripts?: boolean };
  v7Features?: boolean;
  appId?: number;
  portalPageId?: number;
  templateName?: string;
  templateLess?: boolean;
  enableProxyCache?: boolean;
  proxyCacheTTL?: number;
  disableSSLValidation?: boolean;
  distZip?: boolean | { outFileName?: string; outDir?: string; inDir?: string };
  versionPlugin?: boolean | { versionFileTemplate?: string; enabled?: boolean };
  imageOptimizer?: boolean | Record<string, unknown>;
  outDir?: string;
  syncBackupsDir?: string;
  [key: string]: unknown;
}

export interface LegacyPPWatchConfig {
  baseURL: string;
  portalPageId?: number;
}

// ─── Detection ────────────────────────────────────────────────────────────────

const LEGACY_FLAT_KEYS = new Set([
  'backendBaseURL',
  'personalAccessToken',
  'miHudLess',
  'integrateMiTopBar',
  'v7Features',
  'appId',
  'portalPageId',
  'templateName',
  'templateLess',
  'enableProxyCache',
  'proxyCacheTTL',
  'disableSSLValidation',
  'distZip',
  'versionPlugin',
  'imageOptimizer',
  'outDir',
  'syncBackupsDir',
]);

export function isLegacyFlatConfig(config: Record<string, unknown>): boolean {
  return Object.keys(config).some((k) => LEGACY_FLAT_KEYS.has(k));
}

export function isLegacyPPWatchConfig(config: Record<string, unknown>): boolean {
  return 'baseURL' in config;
}

export function isAlreadyMigrated(config: Record<string, unknown>): boolean {
  const NEW_KEYS = new Set(['mi', 'app', 'proxy', 'build', 'sync', 'inspector']);

  return Object.keys(config).some((k) => NEW_KEYS.has(k));
}

// ─── Migration ────────────────────────────────────────────────────────────────

export function migrateLegacyFlatConfig(legacy: LegacyFlatConfig, packageName?: string): PPDevConfig {
  const config: PPDevConfig = {};

  // mi
  const mi: NonNullable<PPDevConfig['mi']> = {};

  if (legacy.backendBaseURL !== undefined) {mi.url = legacy.backendBaseURL;}

  if (legacy.personalAccessToken !== undefined) {mi.token = legacy.personalAccessToken;}

  if (legacy.miHudLess !== undefined) {mi.mode = legacy.miHudLess ? 'standalone' : 'embedding';}

  if (legacy.integrateMiTopBar) {
    if (!mi.mode) {mi.mode = 'standalone';}

    if (legacy.integrateMiTopBar === true) {
      mi.include = 'top-bar';
    } else if (typeof legacy.integrateMiTopBar === 'object') {
      mi.include = legacy.integrateMiTopBar.addRootElement ? 'top-bar' : 'shared-components';
    }
  }

  if (legacy.v7Features !== undefined) {mi.apiVersion = legacy.v7Features ? 7 : 6;}

  if (Object.keys(mi).length > 0) {config.mi = mi;}

  // app
  const app: NonNullable<PPDevConfig['app']> = {};
  const appId = legacy.appId ?? legacy.portalPageId;

  if (appId !== undefined) {app.id = appId;}

  if (legacy.templateName !== undefined && legacy.templateName !== packageName) {app.name = legacy.templateName;}

  if (legacy.templateLess !== undefined) {app.type = legacy.templateLess ? 'page' : 'template';}

  if (Object.keys(app).length > 0) {config.app = app;}

  // proxy
  const proxy: NonNullable<PPDevConfig['proxy']> = {};

  if (legacy.enableProxyCache !== undefined) {proxy.cache = legacy.enableProxyCache;}

  if (legacy.proxyCacheTTL !== undefined) {proxy.cacheTtl = legacy.proxyCacheTTL;}

  if (legacy.disableSSLValidation !== undefined) {proxy.tls = { allowSelfSigned: legacy.disableSSLValidation };}

  if (Object.keys(proxy).length > 0) {config.proxy = proxy;}

  // build
  const build: NonNullable<PPDevConfig['build']> = {};

  if (legacy.outDir !== undefined) {build.outDir = legacy.outDir;}

  if (legacy.distZip !== undefined) {
    if (typeof legacy.distZip === 'object' && legacy.distZip !== null) {
      const zip: Record<string, unknown> = {};

      if (legacy.distZip.outFileName !== undefined) {zip.fileName = legacy.distZip.outFileName;}

      if (legacy.distZip.outDir !== undefined) {zip.outDir = legacy.distZip.outDir;}

      if (legacy.distZip.inDir !== undefined) {zip.inDir = legacy.distZip.inDir;}

      build.zip = Object.keys(zip).length > 0 ? (zip as { fileName?: string; outDir?: string; inDir?: string }) : true;
    } else {
      build.zip = legacy.distZip as boolean;
    }
  }

  if (legacy.versionPlugin !== undefined) {
    if (typeof legacy.versionPlugin === 'object' && legacy.versionPlugin !== null) {
      const vf: { enabled?: boolean; fileNameTemplate?: string } = {};

      if (legacy.versionPlugin.enabled !== undefined) {vf.enabled = legacy.versionPlugin.enabled;}

      if (legacy.versionPlugin.versionFileTemplate !== undefined) {
        vf.fileNameTemplate = legacy.versionPlugin.versionFileTemplate;
      }

      build.versionFile = Object.keys(vf).length > 0 ? vf : true;
    } else {
      build.versionFile = legacy.versionPlugin as boolean;
    }
  }

  if (legacy.imageOptimizer !== undefined) {
    build.imageOptimisations = legacy.imageOptimizer as boolean | Record<string, unknown>;
  }

  if (Object.keys(build).length > 0) {config.build = build;}

  // sync
  if (legacy.syncBackupsDir !== undefined) {config.sync = { backupsDir: legacy.syncBackupsDir };}

  return config;
}

export function migratePPWatchConfig(watchCfg: LegacyPPWatchConfig): PPDevConfig {
  const config: PPDevConfig = { mi: { url: watchCfg.baseURL } };

  if (watchCfg.portalPageId !== undefined) {config.app = { id: watchCfg.portalPageId };}

  return config;
}

// ─── Code generation ──────────────────────────────────────────────────────────

function serializeValue(value: unknown, depth = 0): string {
  const indent = '  '.repeat(depth);
  const innerIndent = '  '.repeat(depth + 1);

  if (value === null) {return 'null';}

  if (typeof value === 'boolean') {return String(value);}

  if (typeof value === 'number') {return String(value);}

  if (typeof value === 'string') {return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;}

  if (Array.isArray(value)) {
    if (value.length === 0) {return '[]';}

    const items = value.map((v) => `${innerIndent}${serializeValue(v, depth + 1)}`).join(',\n');

    return `[\n${items},\n${indent}]`;
  }

  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);

    if (entries.length === 0) {return '{}';}

    const lines = entries.map(([k, v]) => `${innerIndent}${k}: ${serializeValue(v, depth + 1)}`);

    return `{\n${lines.join(',\n')},\n${indent}}`;
  }

  return String(value);
}

export type MigrateOutputFormat = 'ts' | 'js' | 'json';

export function generateConfigFileContent(config: PPDevConfig, format: MigrateOutputFormat = 'ts'): string {
  if (format === 'json') {
    return JSON.stringify(config, null, 2) + '\n';
  }

  const importLine =
    format === 'ts'
      ? `import { defineConfig } from '@metricinsights/pp-dev';`
      : `const { defineConfig } = require('@metricinsights/pp-dev');`;
  const exportLine = format === 'ts' ? 'export default' : 'module.exports =';

  return `${importLine}\n\n${exportLine} defineConfig(${serializeValue(config)});\n`;
}
