/**
 * pp-dev's config: its public types, validation and normalization.
 *
 * Kept free of the dev server's dependencies (express, axios, the proxy, jsdom, …): `withPPDev()`
 * runs while Next.js evaluates next.config, and the CLI reads the config before it knows whether
 * it will serve, so loading the config must not load the server.
 */
import type { ViteImageOptimizer } from 'vite-plugin-image-optimizer';
import { createDefaultZipFileName, normalizeRelativeOutputPath } from './output-path.js';

// ─── Public config types ──────────────────────────────────────────────────────

export type MiMode = 'standalone' | 'embedding';
export type MiInclude = 'shared-components' | 'top-bar';
export type AppType = 'page' | 'template';

export interface MiConfig {
  /** MI instance base URL. Falls back to process.env.MI_BACKEND_URL. */
  url?: string;
  /** Personal Access Token. Falls back to process.env.MI_ACCESS_TOKEN. */
  token?: string;
  /** How the page integrates into MI. @default 'standalone' */
  mode?: MiMode;
  /** Optional MI shared resources. Only valid when mode === 'standalone'. */
  include?: MiInclude;
  /** MI API/routing version. @default 7 */
  apiVersion?: 6 | 7;
}

export interface AppConfig {
  /** Portal page / app ID on MI. Required for type=template and type=page+standalone. */
  id?: number;
  /** Internal asset name. @default package.json#name */
  name?: string;
  /** App type affecting routing and data loading. @default 'template' */
  type?: AppType;
}

export interface ProxyConfig {
  /** Enable request caching to the backend. @default true */
  cache?: boolean;
  /** Cache TTL in milliseconds. @default 600000 */
  cacheTtl?: number;
  tls?: {
    /** Allow self-signed TLS certificates. @default false */
    allowSelfSigned?: boolean;
  };
}

interface DistZipBuildConfig {
  /** Output ZIP file name. @default '<app.name>.zip' */
  fileName?: string;
  /** Output directory for the ZIP archive. @default 'dist-zip' */
  outDir?: string;
  /** Input directory to zip. @default value of build.outDir */
  inDir?: string;
}

interface VersionFileBuildConfig {
  /** @default true */
  enabled?: boolean;
  /** @default 'VERSION-v{packageversion}-{currentDate}.json' */
  fileNameTemplate?: string;
}

export interface BuildConfig {
  /** Build output directory. @default 'dist' */
  outDir?: string;
  /** Pack build output into a ZIP archive. @default true */
  zip?: boolean | DistZipBuildConfig;
  /** Create a VERSION JSON file with SHA256 hashes. @default true */
  versionFile?: boolean | VersionFileBuildConfig;
  /** Image optimisation options. @default true */
  imageOptimisations?: boolean | Record<string, unknown>;
}

export interface SyncConfig {
  /** Directory for sync backups. @default 'backups' */
  backupsDir?: string;
  /**
   * How many backups of this page to keep; each new backup deletes the oldest beyond that.
   * `false` or `0` keeps them all. @default 20
   */
  maxBackups?: number | false;
}

export interface InspectorConfig {
  /** Enable the request inspector web UI at /@pp-dev/inspector. @default true */
  enabled?: boolean;
  /** Maximum RAM for stored request/response payloads in bytes. @default 1073741824 (1 GB) */
  maxMemory?: number;
  /** Maximum bytes captured per individual request/response body. @default 10485760 (10 MB) */
  captureLimit?: number;
}

export type DevPanelPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface DevPanelConfig {
  /** Screen corner the dev panel is anchored to. @default 'bottom-right' */
  position?: DevPanelPosition;
  /** Fully hide the panel. Restore in the browser with ?pp-dev-panel=show. @default false */
  hidden?: boolean;
  /** Auto-hide: the panel slides behind the screen edge leaving a thin strip; hover reveals it. @default false */
  autoHide?: boolean;
}

export interface UsersConfig {
  /**
   * Keep the users added with an API token between dev server runs, in a file in your home
   * directory (`~/.pp-dev/users/`) that only you can read. Passwords and MI sessions are never kept.
   * @default false
   */
  persist?: boolean;
}

export interface PPDevConfig {
  mi?: MiConfig;
  app?: AppConfig;
  proxy?: ProxyConfig;
  build?: BuildConfig;
  sync?: SyncConfig;
  inspector?: InspectorConfig;
  devPanel?: DevPanelConfig;
  /** Working as other MI users (the dev panel's Users section). */
  users?: UsersConfig;
}

// ─── Internal normalized options (used by vitePPDev Vite plugin) ─────────────

export interface VersionPluginOptions {
  /**
   * Version file filename template.
   * Placeholders: {packageversion}, {currentDate}
   * @default "VERSION-v{packageversion}-{currentDate}.json"
   */
  versionFileTemplate?: string;
  /** @default true */
  enabled?: boolean;
}

/** @internal — used by the Vite plugin and CLI; not part of the public API. */
export interface NormalizedVitePPDevOptions {
  templateName: string;
  backendBaseURL?: string;
  appId?: number;
  templateLess: boolean;
  miHudLess: boolean;
  integrateMiTopBar: boolean | { addRootElement?: boolean; addSharedComponentsScripts?: boolean };
  enableProxyCache: boolean;
  proxyCacheTTL: number;
  disableSSLValidation: boolean;
  imageOptimizer: boolean | Parameters<typeof ViteImageOptimizer>[0];
  outDir: string;
  distZip: false | { outFileName: string; outDir: string; inDir?: string };
  versionPlugin: false | VersionPluginOptions;
  syncBackupsDir: string;
  /** `undefined` leaves DistService's default. */
  syncMaxBackups?: number | false;
  v7Features: boolean;
  personalAccessToken?: string;
  inspectorEnabled: boolean;
  inspectorMaxMemory: number;
  inspectorCaptureLimit: number;
  devPanelPosition: DevPanelPosition;
  devPanelHidden: boolean;
  devPanelAutoHide: boolean;
  persistUsers: boolean;
}

const DEV_PANEL_POSITIONS: readonly DevPanelPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

// ─── Validation ───────────────────────────────────────────────────────────────

export function validatePPDevConfig(config: PPDevConfig, templateName: string): void {
  const miMode = config.mi?.mode ?? 'standalone';
  const appType = config.app?.type ?? 'template';
  const apiVersion = config.mi?.apiVersion ?? 7;
  const miUrl = config.mi?.url ?? process.env.MI_BACKEND_URL;

  if (!templateName) {
    throw new Error('[pp-dev] app.name is required (or set package.json#name)');
  }

  if (config.mi?.include && miMode !== 'standalone') {
    console.warn('[pp-dev] mi.include is only valid when mi.mode is "standalone"');
    throw new Error('[pp-dev] mi.include requires mi.mode to be "standalone"');
  }

  if (!miUrl) {
    if (miMode === 'embedding' || appType === 'template') {
      throw new Error('[pp-dev] mi.url is required when mi.mode is "embedding" or app.type is "template"');
    }

    if (miMode === 'standalone' && appType === 'page') {
      console.warn('[pp-dev] mi.url is not set — dev server will run without a backend proxy');
    }
  }

  if (appType === 'template' && !config.app?.id) {
    throw new Error('[pp-dev] app.id is required when app.type is "template"');
  }

  const requiresPageAppId = appType === 'page' && miUrl && (miMode === 'standalone' || apiVersion >= 7);

  if (requiresPageAppId && !config.app?.id) {
    throw new Error('[pp-dev] app.id is required when backend page data is loaded for app.type "page"');
  }

  if (config.devPanel?.position !== undefined && !DEV_PANEL_POSITIONS.includes(config.devPanel.position)) {
    throw new Error(`[pp-dev] devPanel.position must be one of: ${DEV_PANEL_POSITIONS.join(', ')}`);
  }
}

// ─── Normalization ────────────────────────────────────────────────────────────

export function normalizePPDevConfig(config: PPDevConfig, templateName: string): NormalizedVitePPDevOptions {
  const { mi = {}, app = {}, proxy = {}, build = {}, sync = {}, inspector = {}, devPanel = {}, users = {} } = config;

  const miMode = mi.mode ?? 'standalone';
  const appType = app.type ?? 'template';
  const apiVersion = mi.apiVersion ?? 7;

  const miHudLess = miMode === 'standalone';

  let integrateMiTopBar: NormalizedVitePPDevOptions['integrateMiTopBar'] = false;

  if (mi.include === 'top-bar') {
    integrateMiTopBar = true;
  } else if (mi.include === 'shared-components') {
    integrateMiTopBar = { addSharedComponentsScripts: true, addRootElement: false };
  }

  const templateLess = appType === 'page';

  const resolvedName = app.name ?? templateName;
  const defaultVersionFileTemplate = 'VERSION-v{packageversion}-{currentDate}.json';

  let distZip: NormalizedVitePPDevOptions['distZip'];
  const zipCfg = build.zip;

  if (zipCfg === false) {
    distZip = false;
  } else if (zipCfg === true || zipCfg === undefined) {
    distZip = { outFileName: createDefaultZipFileName(resolvedName), outDir: 'dist-zip' };
  } else {
    distZip = {
      outFileName: normalizeRelativeOutputPath(
        zipCfg.fileName ?? createDefaultZipFileName(resolvedName),
        'build.zip.fileName',
      ),
      outDir: zipCfg.outDir ?? 'dist-zip',
      ...(zipCfg.inDir ? { inDir: zipCfg.inDir } : {}),
    };
  }

  let versionPlugin: NormalizedVitePPDevOptions['versionPlugin'];
  const vfCfg = build.versionFile;

  if (vfCfg === false) {
    versionPlugin = false;
  } else if (vfCfg === true || vfCfg === undefined) {
    versionPlugin = { versionFileTemplate: defaultVersionFileTemplate, enabled: true };
  } else {
    versionPlugin = {
      versionFileTemplate: normalizeRelativeOutputPath(
        vfCfg.fileNameTemplate ?? defaultVersionFileTemplate,
        'build.versionFile.fileNameTemplate',
      ),
      enabled: vfCfg.enabled ?? true,
    };
  }

  let imageOptimizer: NormalizedVitePPDevOptions['imageOptimizer'];
  const imgCfg = build.imageOptimisations;

  if (imgCfg === false) {
    imageOptimizer = false;
  } else if (imgCfg === true || imgCfg === undefined) {
    imageOptimizer = {};
  } else {
    imageOptimizer = imgCfg;
  }

  return {
    templateName: resolvedName,
    backendBaseURL: mi.url ?? process.env.MI_BACKEND_URL,
    appId: app.id,
    templateLess,
    miHudLess,
    integrateMiTopBar,
    enableProxyCache: proxy.cache ?? true,
    proxyCacheTTL: proxy.cacheTtl ?? 600_000,
    disableSSLValidation: proxy.tls?.allowSelfSigned ?? false,
    imageOptimizer,
    outDir: build.outDir ?? 'dist',
    distZip,
    versionPlugin,
    syncBackupsDir: sync.backupsDir ?? 'backups',
    syncMaxBackups: sync.maxBackups,
    v7Features: apiVersion >= 7,
    personalAccessToken: mi.token ?? process.env.MI_ACCESS_TOKEN,
    inspectorEnabled: inspector.enabled ?? true,
    inspectorMaxMemory: inspector.maxMemory ?? 1 * 1024 * 1024 * 1024,
    inspectorCaptureLimit: inspector.captureLimit ?? 10 * 1024 * 1024,
    devPanelPosition: devPanel.position ?? 'bottom-right',
    devPanelHidden: devPanel.hidden ?? false,
    devPanelAutoHide: devPanel.autoHide ?? false,
    persistUsers: users.persist ?? false,
  };
}
