/**
 * pp-dev's config: its public types, validation and normalization.
 *
 * Kept free of the dev server's dependencies (express, axios, the proxy, jsdom, …): `withPPDev()`
 * runs while Next.js evaluates next.config, and the CLI reads the config before it knows whether
 * it will serve, so loading the config must not load the server.
 */
import type { ViteImageOptimizer } from 'vite-plugin-image-optimizer';
import { createDefaultZipFileName, normalizeRelativeOutputPath } from './output-path.js';
import { PP_DEV_SWITCHED_ENV_VAR, envVariableSuffix } from '../shared/mi-environments.js';
import { getSessionCookieName } from './session-cookie.middleware.js';

// ─── Public config types ──────────────────────────────────────────────────────

export type MiMode = 'standalone' | 'embedding';
export type MiInclude = 'shared-components' | 'top-bar';
export type AppType = 'page' | 'template';

export interface MiConfig {
  /** MI instance base URL. Falls back to process.env.MI_BACKEND_URL. */
  url?: string;
  /** Personal Access Token. Falls back to process.env.MI_ACCESS_TOKEN. */
  token?: string;
  /**
   * Sync and Variables Editor saves (both write to MI) ask for a confirmation that names the MI
   * environment. Named environments take it too, unless they set `envs.<name>.protected` themselves.
   * @default false
   */
  protected?: boolean;
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
  /**
   * Sync and Variables Editor saves ask for a confirmation that names the environment. Falls back to
   * `mi.protected`, so `false` here leaves a test instance unprotected under a protected default.
   */
  protected?: boolean;
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
  /** Sync and Variables Editor saves ask for a confirmation (`mi.protected`, `envs.<name>.protected`). */
  envProtected: boolean;
  /**
   * The browser's name of the MI session cookie: MI's own for the default instance (`mi.url`),
   * `metric_insights_session__<host>` for another one, so each instance keeps its login on localhost.
   */
  sessionCookieName: string;
  /** The environments the dev panel offers to switch to, `default` first. */
  environments: EnvironmentChoice[];
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

export { envVariableSuffix };

/** The MI instance, page and token of the environment in use. */
export interface ResolvedMiEnvironment {
  /** The named environment (`envs`); `undefined` for the top-level settings. */
  name?: string;
  url?: string;
  appId?: number;
  token?: string;
  /** Sync and Variables Editor saves ask for a confirmation (`protected`). */
  protected?: boolean;
}

/** A `protected` setting is `true` or `false`: a string such as `'true'` would leave it unprotected. */
function checkProtected(value: unknown, setting: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(`[pp-dev] ${setting} must be true or false, got ${JSON.stringify(value)}`);
  }
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

  checkProtected(config.mi?.protected, 'mi.protected');

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
    checkProtected((entry as EnvConfig).protected, `envs.${name}.protected`);
  }

  const defined = [DEFAULT_ENV_NAME, ...names].join(', ');
  const isDefined = (name: string) => name === DEFAULT_ENV_NAME || Object.prototype.hasOwnProperty.call(envs, name);

  if (config.defaultEnv !== undefined && (typeof config.defaultEnv !== 'string' || !isDefined(config.defaultEnv))) {
    throw new Error(
      `[pp-dev] defaultEnv ${JSON.stringify(config.defaultEnv)} is not an environment. Defined: ${defined}`,
    );
  }

  const name = getSelectedEnvName(env) || config.defaultEnv || DEFAULT_ENV_NAME;

  if (!isDefined(name)) {
    const from = env[PP_DEV_SWITCHED_ENV_VAR]?.trim() ? 'chosen in the dev panel' : '--env or MI_ENV';

    throw new Error(`[pp-dev] Unknown MI environment "${name}" (${from}). Defined: ${defined}`);
  }

  if (name === DEFAULT_ENV_NAME) {
    return {
      url: config.mi?.url ?? env.MI_BACKEND_URL,
      appId: config.app?.id,
      token: config.mi?.token ?? env.MI_ACCESS_TOKEN,
      protected: config.mi?.protected,
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
    protected: entry.protected ?? config.mi?.protected,
  };
}

/** The named environments with no URL of their own, neither `envs.<name>.url` nor `MI_BACKEND_URL_<NAME>`. */
export function envsWithoutUrl(config: PPDevConfig, env: Record<string, string | undefined> = process.env): string[] {
  return Object.entries(config.envs ?? {})
    .filter(([name, entry]) => !entry?.url && !env[`MI_BACKEND_URL_${envVariableSuffix(name)}`])
    .map(([name]) => name);
}

/**
 * A named environment's backups folder, inside `backupsDir` and as relative as it is: `''` (the
 * project root) gives `staging`, not `/staging`.
 */
function joinBackupsDir(backupsDir: string, name: string): string {
  const trimmed = backupsDir.replace(/[\\/]+$/, '');

  if (!backupsDir) {
    return name;
  }

  // Only separators (`/`, the root of the drive): kept, the name after it.
  return trimmed ? `${trimmed}/${name}` : `${backupsDir.slice(0, 1)}${name}`;
}

/**
 * Whether `config` defines the environment in use (`MI_ENV`, else `defaultEnv`): `default`, or one
 * of its `envs`. A partial config (the standalone file of a project whose `next.config` adds to it)
 * may leave it to another source.
 */
function definesSelectedEnv(config: PPDevConfig, env: Record<string, string | undefined> = process.env): boolean {
  const name = getSelectedEnvName(env) || config.defaultEnv || DEFAULT_ENV_NAME;

  return name === DEFAULT_ENV_NAME || Object.prototype.hasOwnProperty.call(config.envs ?? {}, name);
}

/** An environment the dev panel offers to switch to (PP-4840 phase 4). */
export interface EnvironmentChoice {
  name: string;
  /** Without a URL it can't be chosen: the restart would refuse it. */
  hasUrl: boolean;
  protected: boolean;
}

/** The environments of a config, `default` first: what the panel offers. */
export function listEnvironmentChoices(
  config: PPDevConfig,
  env: Record<string, string | undefined> = process.env,
): EnvironmentChoice[] {
  const choices: EnvironmentChoice[] = [
    {
      name: DEFAULT_ENV_NAME,
      hasUrl: Boolean(config.mi?.url ?? env.MI_BACKEND_URL),
      protected: config.mi?.protected === true,
    },
  ];

  for (const [name, entry] of Object.entries(config.envs ?? {})) {
    choices.push({
      name,
      hasUrl: Boolean(entry?.url || env[`MI_BACKEND_URL_${envVariableSuffix(name)}`]),
      protected: (entry?.protected ?? config.mi?.protected) === true,
    });
  }

  return choices;
}

/** The environment named in the environment variables: the dev panel's choice, else `MI_ENV`. */
function getSelectedEnvName(env: Record<string, string | undefined>): string | undefined {
  return env[PP_DEV_SWITCHED_ENV_VAR]?.trim() || env.MI_ENV?.trim() || undefined;
}

export interface ValidateOptions {
  /**
   * `config` is only part of the config: the standalone file, which `withPPDev()` in `next.config`
   * may add to. An environment it doesn't define (in `envs`, or named by `defaultEnv`) is left to the
   * server process, which validates the merged config: refused here, no change to the file would
   * ever restart the dev server.
   */
  partial?: boolean;
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * @param templateName - package.json's `name`; `app.name` takes precedence over it, here and in
 *   {@link normalizePPDevConfig} (whose `templateName` is the one name to use from then on).
 */
export function validatePPDevConfig(
  config: PPDevConfig,
  templateName: string | undefined,
  options: ValidateOptions = {},
): void {
  const miMode = config.mi?.mode ?? 'standalone';
  let environment: ResolvedMiEnvironment | undefined;

  if (options.partial && !definesSelectedEnv(config)) {
    // The environments it does define are still checked (names, collisions), as if none were chosen.
    resolveMiEnvironment({ ...config, defaultEnv: undefined }, { MI_ENV: DEFAULT_ENV_NAME });
  } else {
    environment = resolveMiEnvironment(config);

    // The one in use was checked above; choosing one of these stops pp-dev the same way.
    for (const name of envsWithoutUrl(config)) {
      if (name !== environment.name) {
        console.warn(
          `[pp-dev] envs.${name} has no URL (envs.${name}.url or MI_BACKEND_URL_${envVariableSuffix(name)}): --env ${name} would stop with an error`,
        );
      }
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

  if (environment) {
    validateMiEnvironment(config, miMode, environment);
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

/** The environment in use: its URL and app id as the app's type and mode need them. */
function validateMiEnvironment(config: PPDevConfig, miMode: MiMode, environment: ResolvedMiEnvironment): void {
  const appType = config.app?.type ?? 'template';
  const apiVersion = config.mi?.apiVersion ?? 7;
  const miUrl = environment.url;
  const appId = environment.appId;
  // Where a named environment's settings go too.
  const inEnv = (key: string) => (environment.name ? ` (or envs.${environment.name}.${key})` : '');

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
  // The default instance's URL: its session cookie keeps MI's name, so existing logins stay.
  const defaultUrl = environment.name
    ? resolveMiEnvironment(config, { ...process.env, MI_ENV: DEFAULT_ENV_NAME, [PP_DEV_SWITCHED_ENV_VAR]: undefined })
        .url
    : environment.url;

  return {
    templateName: resolvedName,
    envName: environment.name,
    envProtected: environment.protected ?? false,
    sessionCookieName: getSessionCookieName(environment.url, defaultUrl),
    environments: listEnvironmentChoices(config),
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
    syncBackupsDir: environment.name ? joinBackupsDir(backupsDir, environment.name) : backupsDir,
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
