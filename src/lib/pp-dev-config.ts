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
  /**
   * How long the build a sync starts (`pp-dev build`, `next build`) may run, in milliseconds,
   * before it is stopped and the sync fails. @default 600000 (10 minutes)
   */
  buildTimeoutMs?: number;
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

export interface ServerConfig {
  /**
   * Host names the dev server answers besides `localhost`, `*.localhost` and IP addresses, as
   * Vite's `server.allowedHosts`: `'my-app.ngrok.app'`, or `'.ngrok.app'` for that domain and its
   * subdomains. Any other `Host` is refused (DNS rebinding). The value of `--host` is allowed too.
   * Pages on the names listed without a leading dot may also use the dev server's API, its
   * WebSocket and, under `pp-dev next`, Next's HMR (`withPPDev()` adds them to Next's
   * `allowedDevOrigins` in development): a page through a tunnel. `true` answers any host; avoid it.
   * @default []
   */
  allowedHosts?: string[] | true;
}

/**
 * A named MI environment (`envs.<name>`): another MI instance, or another page on the same one.
 * What it leaves out comes from the top-level `mi` and `app`, except the token.
 */
export interface EnvConfig {
  /**
   * MI instance base URL. Falls back to `MI_BACKEND_URL_<NAME>`; one of the two is required, also for
   * another page on the default instance (never the top-level `mi.url`: a URL left out of a `.env`
   * file would point the environment, and its sync, at the default MI).
   */
  url?: string;
  /** Portal page / app ID on that instance. Falls back to the top-level `app.id`. */
  appId?: number;
  /**
   * Personal Access Token. Falls back to `MI_ACCESS_TOKEN_<NAME>`, never to `mi.token` or
   * `MI_ACCESS_TOKEN`: those may belong to another instance. Without one, log in to MI on localhost.
   */
  token?: string;
}

export interface PPDevConfig {
  mi?: MiConfig;
  app?: AppConfig;
  /**
   * Named MI environments, chosen with `--env <name>` or `MI_ENV`. The top-level `mi` and `app`
   * are the `default` one. `<NAME>` in their variables is the name in upper case, with anything
   * other than a letter or digit as `_` (`staging-eu` reads `MI_ACCESS_TOKEN_STAGING_EU`).
   */
  envs?: Record<string, EnvConfig>;
  /** The environment used when neither `--env` nor `MI_ENV` names one. @default 'default' */
  defaultEnv?: string;
  proxy?: ProxyConfig;
  build?: BuildConfig;
  sync?: SyncConfig;
  inspector?: InspectorConfig;
  devPanel?: DevPanelConfig;
  /** Working as other MI users (the dev panel's Users section). */
  users?: UsersConfig;
  /** The dev server itself (`pp-dev` and `pp-dev next`). */
  server?: ServerConfig;
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
  /** The named MI environment in use (`envs`); `undefined` for the top-level settings. */
  envName?: string;
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
  /** `undefined` leaves DistService's default. */
  syncBuildTimeoutMs?: number;
  v7Features: boolean;
  personalAccessToken?: string;
  inspectorEnabled: boolean;
  inspectorMaxMemory: number;
  inspectorCaptureLimit: number;
  devPanelPosition: DevPanelPosition;
  devPanelHidden: boolean;
  devPanelAutoHide: boolean;
  persistUsers: boolean;
  /** `server.allowedHosts`, lowercased. */
  allowedHosts: string[] | true;
}

const DEV_PANEL_POSITIONS: readonly DevPanelPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/** The longest delay `setTimeout` takes (2³¹ − 1 ms, about 24.8 days). */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

// ─── MI environments ──────────────────────────────────────────────────────────

/** The name the top-level `mi` and `app` settings go by in `--env`, `MI_ENV` and `defaultEnv`. */
export const DEFAULT_ENV_NAME = 'default';

/** Also a folder name (`backups/<name>`): no path separators, no dots. */
const ENV_NAME_REGEXP = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The suffix of an environment's variables: `staging-eu` → `STAGING_EU` (`MI_ACCESS_TOKEN_STAGING_EU`). */
export function envVariableSuffix(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** The MI instance, page and token of the environment in use. */
export interface ResolvedMiEnvironment {
  /** The named environment (`envs`); `undefined` for the top-level settings. */
  name?: string;
  url?: string;
  appId?: number;
  token?: string;
}

/**
 * The environment `MI_ENV` (which `--env` sets), else `defaultEnv`, else the top-level settings
 * name. A name that isn't defined is an error, never the default: that would be another MI instance.
 */
export function resolveMiEnvironment(
  config: PPDevConfig,
  env: Record<string, string | undefined> = process.env,
): ResolvedMiEnvironment {
  const envs: Record<string, EnvConfig> = config.envs ?? {};

  if (typeof envs !== 'object' || Array.isArray(envs)) {
    throw new Error('[pp-dev] envs must be an object of named environments');
  }

  const names = Object.keys(envs);
  const bySuffix = new Map<string, string>();

  for (const name of names) {
    if (name === DEFAULT_ENV_NAME) {
      throw new Error(
        `[pp-dev] envs.${DEFAULT_ENV_NAME} is reserved: the top-level mi and app settings are the default environment`,
      );
    }

    if (!ENV_NAME_REGEXP.test(name)) {
      throw new Error(
        `[pp-dev] envs.${name}: an environment name takes letters, digits, "-" and "_", and starts with a letter or digit`,
      );
    }

    const entry: unknown = envs[name];

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`[pp-dev] envs.${name} must be an object ({ url, appId, token })`);
    }

    const suffix = envVariableSuffix(name);
    const other = bySuffix.get(suffix);

    if (other !== undefined) {
      throw new Error(`[pp-dev] envs.${other} and envs.${name} would both read MI_ACCESS_TOKEN_${suffix}: rename one`);
    }

    bySuffix.set(suffix, name);
  }

  const defined = [DEFAULT_ENV_NAME, ...names].join(', ');
  const isDefined = (name: string) => name === DEFAULT_ENV_NAME || Object.prototype.hasOwnProperty.call(envs, name);

  if (config.defaultEnv !== undefined && (typeof config.defaultEnv !== 'string' || !isDefined(config.defaultEnv))) {
    throw new Error(
      `[pp-dev] defaultEnv ${JSON.stringify(config.defaultEnv)} is not an environment. Defined: ${defined}`,
    );
  }

  const fromVariable = env.MI_ENV?.trim();
  const name = fromVariable || config.defaultEnv || DEFAULT_ENV_NAME;

  if (!isDefined(name)) {
    throw new Error(`[pp-dev] Unknown MI environment "${name}" (--env or MI_ENV). Defined: ${defined}`);
  }

  if (name === DEFAULT_ENV_NAME) {
    return {
      url: config.mi?.url ?? env.MI_BACKEND_URL,
      appId: config.app?.id,
      token: config.mi?.token ?? env.MI_ACCESS_TOKEN,
    };
  }

  const entry = envs[name];
  const suffix = envVariableSuffix(name);
  const url = entry.url || env[`MI_BACKEND_URL_${suffix}`];

  // Never the default one's: a URL left out of a `.env` file would point the environment, and a
  // sync from it, at the default MI.
  if (!url) {
    throw new Error(
      `[pp-dev] MI environment "${name}" has no URL: set envs.${name}.url or MI_BACKEND_URL_${suffix} ` +
        '(the same URL as mi.url for another page on the default instance)',
    );
  }

  return {
    name,
    url,
    appId: entry.appId ?? config.app?.id,
    // Never the top-level token: it may belong to another instance, and would be sent there.
    token: entry.token ?? env[`MI_ACCESS_TOKEN_${suffix}`],
  };
}

/** The named environments with no URL of their own, neither `envs.<name>.url` nor `MI_BACKEND_URL_<NAME>`. */
export function envsWithoutUrl(config: PPDevConfig, env: Record<string, string | undefined> = process.env): string[] {
  return Object.entries(config.envs ?? {})
    .filter(([name, entry]) => !entry?.url && !env[`MI_BACKEND_URL_${envVariableSuffix(name)}`])
    .map(([name]) => name);
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * @param templateName - package.json's `name`; `app.name` takes precedence over it, here and in
 *   {@link normalizePPDevConfig} (whose `templateName` is the one name to use from then on).
 */
export function validatePPDevConfig(config: PPDevConfig, templateName: string | undefined): void {
  const miMode = config.mi?.mode ?? 'standalone';
  const appType = config.app?.type ?? 'template';
  const apiVersion = config.mi?.apiVersion ?? 7;
  const environment = resolveMiEnvironment(config);
  const miUrl = environment.url;
  const appId = environment.appId;
  // Where a named environment's settings go too.
  const inEnv = (key: string) => (environment.name ? ` (or envs.${environment.name}.${key})` : '');

  // The one in use was checked above; choosing one of these stops pp-dev the same way.
  for (const name of envsWithoutUrl(config)) {
    if (name !== environment.name) {
      console.warn(
        `[pp-dev] envs.${name} has no URL (envs.${name}.url or MI_BACKEND_URL_${envVariableSuffix(name)}): --env ${name} would stop with an error`,
      );
    }
  }

  if (!(config.app?.name ?? templateName)) {
    throw new Error('[pp-dev] app.name is required (or set package.json#name)');
  }

  const maxBackups = config.sync?.maxBackups;

  if (maxBackups !== undefined && maxBackups !== false && !(Number.isInteger(maxBackups) && maxBackups >= 0)) {
    throw new Error(
      `[pp-dev] sync.maxBackups must be a whole number ≥ 0 or false (0 and false keep every backup), got ${JSON.stringify(maxBackups)}`,
    );
  }

  const buildTimeoutMs = config.sync?.buildTimeoutMs;

  // Capped at the longest delay a Node timer takes: `setTimeout` turns a longer one into 1 ms, and
  // the build would be stopped at once.
  if (
    buildTimeoutMs !== undefined &&
    !(Number.isInteger(buildTimeoutMs) && buildTimeoutMs > 0 && buildTimeoutMs <= MAX_TIMER_DELAY_MS)
  ) {
    throw new Error(
      `[pp-dev] sync.buildTimeoutMs must be a whole number of milliseconds between 1 and ${MAX_TIMER_DELAY_MS}, got ${JSON.stringify(buildTimeoutMs)}`,
    );
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

  if (appType === 'template' && !appId) {
    throw new Error(`[pp-dev] app.id${inEnv('appId')} is required when app.type is "template"`);
  }

  const requiresPageAppId = appType === 'page' && miUrl && (miMode === 'standalone' || apiVersion >= 7);

  if (requiresPageAppId && !appId) {
    throw new Error(
      `[pp-dev] app.id${inEnv('appId')} is required when backend page data is loaded for app.type "page"`,
    );
  }

  if (config.devPanel?.position !== undefined && !DEV_PANEL_POSITIONS.includes(config.devPanel.position)) {
    throw new Error(`[pp-dev] devPanel.position must be one of: ${DEV_PANEL_POSITIONS.join(', ')}`);
  }

  const allowedHosts: unknown = config.server?.allowedHosts;

  if (
    allowedHosts !== undefined &&
    allowedHosts !== true &&
    !(Array.isArray(allowedHosts) && allowedHosts.every((host) => typeof host === 'string' && host.trim() !== ''))
  ) {
    throw new Error(
      `[pp-dev] server.allowedHosts must be a list of host names or true, got ${JSON.stringify(allowedHosts)}`,
    );
  }
}

// ─── Normalization ────────────────────────────────────────────────────────────

export function normalizePPDevConfig(
  config: PPDevConfig,
  templateName: string | undefined,
): NormalizedVitePPDevOptions {
  const {
    mi = {},
    app = {},
    proxy = {},
    build = {},
    sync = {},
    inspector = {},
    devPanel = {},
    users = {},
    server = {},
  } = config;

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

  if (!resolvedName) {
    throw new Error('[pp-dev] app.name is required (or set package.json#name)');
  }

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

  const environment = resolveMiEnvironment(config);
  const backupsDir = sync.backupsDir ?? 'backups';

  return {
    templateName: resolvedName,
    envName: environment.name,
    backendBaseURL: environment.url,
    appId: environment.appId,
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
    // A named environment's backups apart: the changelog compares a build with the latest one, which
    // must be of the same page on the same instance. The default one's stay where they always were.
    syncBackupsDir: environment.name ? `${backupsDir.replace(/[\\/]+$/, '')}/${environment.name}` : backupsDir,
    syncMaxBackups: sync.maxBackups,
    syncBuildTimeoutMs: sync.buildTimeoutMs,
    v7Features: apiVersion >= 7,
    personalAccessToken: environment.token,
    inspectorEnabled: inspector.enabled ?? true,
    inspectorMaxMemory: inspector.maxMemory ?? 1 * 1024 * 1024 * 1024,
    inspectorCaptureLimit: inspector.captureLimit ?? 10 * 1024 * 1024,
    devPanelPosition: devPanel.position ?? 'bottom-right',
    devPanelHidden: devPanel.hidden ?? false,
    devPanelAutoHide: devPanel.autoHide ?? false,
    persistUsers: users.persist ?? false,
    allowedHosts:
      server.allowedHosts === true ? true : (server.allowedHosts ?? []).map((host) => host.trim().toLowerCase()),
  };
}
