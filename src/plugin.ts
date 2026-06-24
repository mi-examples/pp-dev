import { IndexHtmlTransformResult, Plugin } from 'vite';
import proxyPassMiddleware from './lib/proxy-pass.middleware.js';
import { MiAPI } from './lib/pp.middleware.js';
import { redirect, urlReplacer } from './lib/helpers/url.helper.js';
import { ClientService } from './lib/client.service.js';
import { initProxyCache } from './lib/proxy-cache.middleware.js';
import { DistService } from './lib/dist.service.js';
import { initRewriteResponse } from './lib/rewrite-response.middleware.js';
import { initPPRedirect } from './lib/pp-redirect.middleware.js';
import { initLoadPPData } from './lib/load-pp-data.middleware.js';
import type { ViteImageOptimizer } from 'vite-plugin-image-optimizer';
import { createInternalServer } from './lib/internal.middleware.js';
import { getTokenErrorInfo } from './lib/helpers/index.js';
import { RequestStore } from './lib/request-store.js';
import { createRequestCaptureMiddleware } from './lib/request-capture.middleware.js';
import { registerInspectorRoutes } from './lib/request-inspector.js';

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
}

export interface InspectorConfig {
  /** Enable the request inspector web UI at /@pp-dev/inspector. @default true */
  enabled?: boolean;
  /** Maximum RAM for stored request/response payloads in bytes. @default 1073741824 (1 GB) */
  maxMemory?: number;
  /** Maximum bytes captured per individual request/response body. @default 10485760 (10 MB) */
  captureLimit?: number;
}

export interface PPDevConfig {
  mi?: MiConfig;
  app?: AppConfig;
  proxy?: ProxyConfig;
  build?: BuildConfig;
  sync?: SyncConfig;
  inspector?: InspectorConfig;
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
  v7Features: boolean;
  personalAccessToken?: string;
  inspectorEnabled: boolean;
  inspectorMaxMemory: number;
  inspectorCaptureLimit: number;
}

// ─── Validation ───────────────────────────────────────────────────────────────

export function validatePPDevConfig(config: PPDevConfig, templateName: string): void {
  const miMode = config.mi?.mode ?? 'standalone';
  const appType = config.app?.type ?? 'template';
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
      throw new Error(
        '[pp-dev] mi.url is required when mi.mode is "embedding" or app.type is "template"',
      );
    }

    if (miMode === 'standalone' && appType === 'page') {
      console.warn('[pp-dev] mi.url is not set — dev server will run without a backend proxy');
    }
  }

  if (appType === 'template' && !config.app?.id) {
    throw new Error('[pp-dev] app.id is required when app.type is "template"');
  }

  if (appType === 'page' && miMode === 'standalone' && !config.app?.id) {
    throw new Error('[pp-dev] app.id is required when app.type is "page" and mi.mode is "standalone"');
  }
}

// ─── Normalization ────────────────────────────────────────────────────────────

export function normalizePPDevConfig(config: PPDevConfig, templateName: string): NormalizedVitePPDevOptions {
  const { mi = {}, app = {}, proxy = {}, build = {}, sync = {}, inspector = {} } = config;

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
    distZip = { outFileName: `${resolvedName}.zip`, outDir: 'dist-zip' };
  } else {
    distZip = {
      outFileName: zipCfg.fileName ?? `${resolvedName}.zip`,
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
      versionFileTemplate: vfCfg.fileNameTemplate ?? defaultVersionFileTemplate,
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
    v7Features: apiVersion >= 7,
    personalAccessToken: mi.token ?? process.env.MI_ACCESS_TOKEN,
    inspectorEnabled: inspector.enabled ?? true,
    inspectorMaxMemory: inspector.maxMemory ?? 1 * 1024 * 1024 * 1024,
    inspectorCaptureLimit: inspector.captureLimit ?? 10 * 1024 * 1024,
  };
}

// ─── Internal MiAPI config ────────────────────────────────────────────────────

interface MiAPIConfig {
  headers: {
    host: string;
    referer: string;
    origin: string;
  };
  appId?: number;
  templateLess: boolean;
  disableSSLValidation: boolean;
  v7Features: boolean;
  personalAccessToken?: string;
}

// ─── Vite plugin ──────────────────────────────────────────────────────────────

function vitePPDev(options: NormalizedVitePPDevOptions): Plugin {
  const {
    templateName,
    templateLess,
    backendBaseURL,
    miHudLess,
    appId,
    enableProxyCache,
    proxyCacheTTL,
    disableSSLValidation,
    distZip,
    versionPlugin,
    syncBackupsDir,
    v7Features,
    personalAccessToken,
    inspectorEnabled,
    inspectorMaxMemory,
    inspectorCaptureLimit,
  } = options || {};

  let isFirstRequest = true;
  let baseDir = process.cwd();

  return {
    name: 'vite-pp-dev',
    apply: 'serve',
    config: (config) => {
      config.clientInjectionPlugin = {
        backendBaseURL,
        appId,
        templateLess,
        v7Features,
      };

      if (v7Features) {
        config.base = `/pl/${templateName}`;
      }

      if (config.root) {
        baseDir = config.root;
      }

      return config;
    },
    transformIndexHtml: async (_html, _ctx) => {
      const result: IndexHtmlTransformResult = { html: _html, tags: [] };

      if (isFirstRequest) {
        isFirstRequest = false;
        result.tags.push({ tag: 'script', injectTo: 'body', children: `${Math.random()}` });
      }

      return result;
    },
    configureServer: (server) => {
      let base = server.config.base;

      if (!base.endsWith('/')) {
        base += '/';
      }

      const baseWithoutTrailingSlash = base.substring(0, base.lastIndexOf('/'));

      server.middlewares.use(initPPRedirect(base, templateName));

      if (inspectorEnabled !== false) {
        const reqStore = new RequestStore(inspectorMaxMemory);

        server.middlewares.use(createRequestCaptureMiddleware(reqStore, inspectorCaptureLimit));

        const internalServer = createInternalServer();

        registerInspectorRoutes(internalServer, reqStore, inspectorCaptureLimit);
        server.middlewares.use(internalServer);
      }

      if (backendBaseURL) {
        const baseUrlHost = new URL(backendBaseURL).host;

        const miConfig: MiAPIConfig = {
          headers: {
            host: baseUrlHost,
            referer: backendBaseURL,
            origin: backendBaseURL.replace(/^(https?:\/\/)([^/]+)(\/.*)?$/i, '$1$2'),
          },
          appId,
          templateLess,
          disableSSLValidation,
          v7Features,
          personalAccessToken: personalAccessToken ?? process.env.MI_ACCESS_TOKEN,
        };

        const mi = new MiAPI(backendBaseURL, miConfig);

        if (enableProxyCache) {
          let ttl = +proxyCacheTTL;

          if (!ttl || Number.isNaN(ttl) || ttl < 0) {
            ttl = 10 * 60 * 1000;
          }

          server.middlewares.use(initProxyCache({ devServer: server, ttl }));
        }

        const isIndexRegExp = new RegExp(`^((${base})|/)$`);

        server.middlewares.use(
          initLoadPPData(
            isIndexRegExp,
            mi,
            Object.assign({}, options, { appId, appBase: base }),
          ),
        );

        server.middlewares.use(
          proxyPassMiddleware({
            devServer: server,
            baseURL: backendBaseURL,
            proxyIgnore: ['/@vite', '/@metricinsights', '/@', baseWithoutTrailingSlash],
            disableSSLValidation,
            miAPI: mi,
            templateName,
          }),
        );

        const sendErrorResponse = (res: any, status: number, error: string, details?: string, code?: string) => {
          const response: any = { error };

          if (details) {
            response.details = details;
          }

          if (code) {
            response.code = code;
          }

          res.status(status).json(response).end();
        };

        const handleTokenValidationError = (res: any, error: any, tokenType: string) => {
          server.config.logger.error(`${tokenType} token validation error:`, error);

          const errorInfo = getTokenErrorInfo(error);

          if (error.tokenErrorInfo) {
            const enhancedErrorInfo = error.tokenErrorInfo;

            sendErrorResponse(
              res,
              enhancedErrorInfo.status || 500,
              enhancedErrorInfo.userFriendlyMessage,
              enhancedErrorInfo.message,
              enhancedErrorInfo.code,
            );
          } else {
            let status: number;
            let errorMessage: string;
            let errorCode: string;

            switch (errorInfo.code) {
              case 'SESSION_EXPIRED':
                status = 412;
                errorMessage = tokenType === 'personal' ? 'Personal access token expired' : 'Session expired';
                errorCode = tokenType === 'personal' ? 'PAT_EXPIRED' : 'SESSION_EXPIRED';
                break;
              case 'UNAUTHORIZED':
                status = 401;
                errorMessage = 'Unauthorized';
                errorCode = 'UNAUTHORIZED';
                break;
              case 'FORBIDDEN':
                status = 403;
                errorMessage = 'Access forbidden';
                errorCode = 'FORBIDDEN';
                break;
              default:
                status = 500;
                errorMessage = 'Internal server error';
                errorCode = errorInfo.code;
            }

            const details =
              tokenType === 'personal' && errorCode === 'PAT_EXPIRED'
                ? 'Your personal access token has expired. Please generate a new token from the portal.'
                : tokenType === 'regular' && errorCode === 'SESSION_EXPIRED'
                  ? 'Your portal session has expired. Please refresh your token or re-authenticate.'
                  : errorInfo.userFriendlyMessage;

            sendErrorResponse(res, status, errorMessage, details, errorCode);
          }

          return null;
        };

        const internalServer = createInternalServer();

        internalServer.post('/@api/login', async (req, res, next) => {
          const { token, tokenType } = req.body;

          if (!token) {
            sendErrorResponse(res, 400, 'Token is required');

            return;
          }

          server.config.logger.info(`Attempting to validate ${tokenType} token...`);

          if (tokenType === 'personal') {
            const testRequest = await mi
              .get<{ user: { user_id: number; username: string } }>(
                '/data/page/index/auth/info',
                {
                  'Content-Type': 'application/json',
                  Accept: 'application/json',
                  Authorization: `Bearer ${token}`,
                },
                true,
              )
              .then(async (response) => {
                if (typeof response.data?.user?.user_id === 'number') {
                  mi.personalAccessToken = token;

                  server.config.logger.info(
                    `Personal access token validated successfully for user ${response.data.user.user_id}`,
                  );

                  return response;
                }

                sendErrorResponse(res, 400, 'Token expired or invalid');

                return null;
              })
              .catch((error: any) => handleTokenValidationError(res, error, 'personal'));

            if (!testRequest) {
              return;
            }

            redirect(res, '/', 302);
          } else if (tokenType === 'regular') {
            const testRequest = await mi
              .get<{ users: { user_id: number; username: string }[] }>(
                '/api/user',
                {
                  'Content-Type': 'application/json',
                  Accept: 'application/json',
                  Token: token,
                },
                true,
              )
              .then((response) => {
                if (response.data?.users?.length) {
                  mi.personalAccessToken = undefined;

                  server.config.logger.info(
                    `Regular token validated successfully for ${response.data.users.length} user(s)`,
                  );

                  res.setHeader('set-cookie', response.headers['set-cookie'] ?? '');

                  return response;
                }

                sendErrorResponse(res, 400, 'Token expired or invalid');

                return null;
              })
              .catch((error: any) => handleTokenValidationError(res, error, 'regular'));

            if (!testRequest) {
              return;
            }

            redirect(res, '/', 302);
          } else {
            sendErrorResponse(
              res,
              400,
              'Invalid tokenType',
              'tokenType must be "personal" or "regular".',
              'INVALID_TOKEN_TYPE',
            );
          }
        });

        server.middlewares.use(internalServer);

        const distService =
          distZip !== false
            ? new DistService(
                templateName,
                Object.assign(
                  { backupDir: syncBackupsDir },
                  typeof distZip === 'object'
                    ? {
                        distZipFolder: distZip.outDir,
                        distZipFilename: distZip.outFileName,
                      }
                    : undefined,
                  typeof versionPlugin === 'object'
                    ? {
                        versionFileTemplate: versionPlugin.versionFileTemplate,
                      }
                    : undefined,
                ),
              )
            : undefined;

        new ClientService(server, { distService, miAPI: mi });

        return () => {
          server.middlewares.use(
            initRewriteResponse(
              (url) => {
                return url.split('?')[0].endsWith('index.html');
              },
              (response, req) => {
                return Buffer.from(urlReplacer(baseUrlHost, req.headers.host ?? '', mi.buildPage(response, miHudLess)));
              },
            ),
          );
        };
      }
    },
  };
}

export default vitePPDev;
export { vitePPDev };
