import { IndexHtmlTransformResult, Plugin } from 'vite';
import proxyPassMiddleware from './lib/proxy-pass.middleware.js';
import { MiAPI } from './lib/pp.middleware.js';
import { urlReplacer } from './lib/helpers/url.helper.js';
import { ClientService } from './lib/client.service.js';
import { initProxyCache } from './lib/proxy-cache.middleware.js';
import { DistService } from './lib/dist.service.js';
import { initRewriteResponse } from './lib/rewrite-response.middleware.js';
import { initPPRedirect } from './lib/pp-redirect.middleware.js';
import { initLoadPPData } from './lib/load-pp-data.middleware.js';
import type { ViteImageOptimizer } from 'vite-plugin-image-optimizer';

type RequiredSelection<T, K extends keyof T> = Required<Pick<T, K>> & Omit<T, K>;

interface DistZipOptions {
  /**
   * Output ZIP archive file name.
   * You can use `[templateName]` placeholder to replace it with the template name.
   * @default `${templateName}.zip`
   */
  outFileName?: string;

  /**
   * Output directory for the build.
   * @default 'dist-zip'
   */
  outDir?: string;
}

export interface VitePPDevOptions {
  /**
   * Backend base URL to MI instance for the local proxy.
   */
  backendBaseURL?: string;

  /**
   * Portal page ID on the MI instance.
   */
  portalPageId?: number;

  /**
   * Template name or PP internal name that will be used for the asset generation.
   * Equals to package.json name field value.
   */
  templateName: string;

  /**
   * Enable or disable template variables loading from the backend.
   */
  templateLess?: boolean;

  /**
   * Enable or disable MI top bar and scripts loading from the backend for local development.
   */
  miHudLess?: boolean;

  /**
   * Enable or disable request caching to the backend by the local proxy.
   * @default true
   */
  enableProxyCache?: boolean;

  /**
   * Request caching time in milliseconds.
   * @default 600000 (10 minutes)
   */
  proxyCacheTTL?: number;

  /**
   * Disable SSL certificate validation for MI instances with self-signed certificates.
   * @default false
   */
  disableSSLValidation?: boolean;

  /**
   * Image optimizer options.
   * @default true
   */
  imageOptimizer?: boolean | Parameters<typeof ViteImageOptimizer>[0];

  /**
   * Output directory for the build.
   * @default 'dist'
   */
  outDir?: string;

  /**
   * Disable or enable packing the build output into a ZIP archive.
   * @default true
   */
  distZip?: boolean | DistZipOptions;

  /**
   * Backups an asset directory path for sync with the MI instance.
   * @default backups
   */
  syncBackupsDir?: string;

  /**
   * Enable Metric Insights v7 features.
   * @default false
   * @since 0.8.0
   */
  v7Features?: boolean;
}

export type NormalizedVitePPDevOptions = RequiredSelection<
  VitePPDevOptions,
  | 'templateName'
  | 'templateLess'
  | 'miHudLess'
  | 'enableProxyCache'
  | 'proxyCacheTTL'
  | 'disableSSLValidation'
  | 'imageOptimizer'
  | 'outDir'
  | 'distZip'
  | 'syncBackupsDir'
  | 'v7Features'
>;

function isVitePPDevOptions(options: any): options is VitePPDevOptions {
  return (
    typeof options === 'object' &&
    typeof options.templateName === 'string' &&
    (typeof options.backendBaseURL === 'string' || options.backendBaseURL === undefined) &&
    (typeof options.portalPageId === 'number' || options.portalPageId === undefined) &&
    (typeof options.templateLess === 'boolean' || options.templateLess === undefined) &&
    (typeof options.miHudLess === 'boolean' || options.miHudLess === undefined) &&
    (typeof options.enableProxyCache === 'boolean' || options.enableProxyCache === undefined) &&
    (typeof options.proxyCacheTTL === 'number' || options.proxyCacheTTL === undefined) &&
    (typeof options.disableSSLValidation === 'boolean' || options.disableSSLValidation === undefined) &&
    (typeof options.imageOptimizer === 'boolean' ||
      typeof options.imageOptimizer === 'object' ||
      options.imageOptimizer === undefined) &&
    (typeof options.outDir === 'string' || options.outDir === undefined) &&
    (typeof options.distZip === 'boolean' || typeof options.distZip === 'object' || options.distZip === undefined) &&
    (typeof options.syncBackupsDir === 'string' || options.syncBackupsDir === undefined) &&
    (typeof options.v7Features === 'boolean' || options.v7Features === undefined)
  );
}

function throwConfigError(config: VitePPDevOptions) {
  if (typeof config !== 'object') {
    throw new Error('VitePPDevOptions must be an object');
  }

  if (typeof config.templateName !== 'string') {
    throw new Error('VitePPDevOptions.templateName must be a string');
  }

  if (config.backendBaseURL !== undefined && typeof config.backendBaseURL !== 'string') {
    throw new Error('VitePPDevOptions.backendBaseURL must be a string');
  }

  if (config.portalPageId !== undefined && typeof config.portalPageId !== 'number') {
    throw new Error('VitePPDevOptions.portalPageId must be a number');
  }

  if (config.templateLess !== undefined && typeof config.templateLess !== 'boolean') {
    throw new Error('VitePPDevOptions.templateLess must be a boolean');
  }

  if (config.miHudLess !== undefined && typeof config.miHudLess !== 'boolean') {
    throw new Error('VitePPDevOptions.miHudLess must be a boolean');
  }

  if (config.enableProxyCache !== undefined && typeof config.enableProxyCache !== 'boolean') {
    throw new Error('VitePPDevOptions.enableProxyCache must be a boolean');
  }

  if (config.proxyCacheTTL !== undefined && typeof config.proxyCacheTTL !== 'number') {
    throw new Error('VitePPDevOptions.proxyCacheTTL must be a number');
  }

  if (config.disableSSLValidation !== undefined && typeof config.disableSSLValidation !== 'boolean') {
    throw new Error('VitePPDevOptions.disableSSLValidation must be a boolean');
  }

  if (
    config.imageOptimizer !== undefined &&
    typeof config.imageOptimizer !== 'boolean' &&
    typeof config.imageOptimizer !== 'object'
  ) {
    throw new Error('VitePPDevOptions.imageOptimizer must be a boolean or an object');
  }

  if (config.outDir !== undefined && typeof config.outDir !== 'string') {
    throw new Error('VitePPDevOptions.outDir must be a string');
  }

  if (config.distZip !== undefined && typeof config.distZip !== 'boolean' && typeof config.distZip !== 'object') {
    throw new Error('VitePPDevOptions.distZip must be a boolean or an object');
  }

  if (config.syncBackupsDir !== undefined && typeof config.syncBackupsDir !== 'string') {
    throw new Error('VitePPDevOptions.syncBackupsDir must be a string');
  }

  if (config.v7Features !== undefined && typeof config.v7Features !== 'boolean') {
    throw new Error('VitePPDevOptions.v7Features must be a boolean');
  }
}

export function normalizeVitePPDevConfig(config: VitePPDevOptions): NormalizedVitePPDevOptions {
  !isVitePPDevOptions(config) && throwConfigError(config);

  const {
    enableProxyCache = true,
    proxyCacheTTL = 10 * 60 * 1000,
    disableSSLValidation = false,
    imageOptimizer = true,
    miHudLess = false,
    templateLess = false,
    outDir = 'dist',
    distZip = true,
    syncBackupsDir = 'backups',
    v7Features = false,
  } = config || {};

  let distZipConfig = distZip;

  if (distZipConfig === true) {
    distZipConfig = {
      outFileName: `${config.templateName}.zip`,
      outDir: 'dist-zip',
    };
  } else if (typeof distZip === 'object') {
    distZipConfig = {
      outFileName:
        typeof distZip.outFileName === 'string'
          ? distZip.outFileName.replace('[templateName]', config.templateName)
          : `${config.templateName}.zip`,
      outDir: distZip.outDir ?? 'dist-zip',
    };
  } else {
    distZipConfig = false;
  }

  let imageOptimizerConfig = imageOptimizer;

  if (typeof imageOptimizer === 'boolean') {
    if (imageOptimizerConfig === true) {
      imageOptimizerConfig = {};
    }
  } else if (typeof imageOptimizer !== 'object') {
    imageOptimizerConfig = false;
  }

  return {
    enableProxyCache,
    proxyCacheTTL,
    disableSSLValidation,
    imageOptimizer: imageOptimizerConfig,
    templateLess,
    miHudLess,
    outDir,
    distZip: distZipConfig,
    syncBackupsDir,
    v7Features,
    ...config,
  } as NormalizedVitePPDevOptions;
}

function vitePPDev(options: NormalizedVitePPDevOptions): Plugin {
  const {
    templateName,
    templateLess,
    backendBaseURL,
    miHudLess,
    portalPageId,
    enableProxyCache,
    proxyCacheTTL,
    disableSSLValidation,
    distZip,
    syncBackupsDir,
    v7Features,
  } = options || {};

  // Avoid server caching for index.html file when first loading
  let isFirstRequest = true;

  let baseDir = process.cwd();

  return {
    name: 'vite-pp-dev',
    apply: 'serve',
    config: (config) => {
      config.clientInjectionPlugin = { backendBaseURL, portalPageId, templateLess, v7Features };

      if (v7Features) {
        config.base = `/pl/${templateName}`;
      }

      if (config.root) {
        baseDir = config.root;
      }

      return config;
    },
    transformIndexHtml: async (html, ctx) => {
      const result: IndexHtmlTransformResult = { html, tags: [] };

      if (isFirstRequest) {
        isFirstRequest = false;

        result.tags.push({
          tag: 'script',
          injectTo: 'body',
          children: `${Math.random()}`,
        });
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

      if (backendBaseURL) {
        const baseUrlHost = new URL(backendBaseURL).host;

        const mi = new MiAPI(backendBaseURL, {
          headers: {
            host: baseUrlHost,
            referer: backendBaseURL,
            origin: backendBaseURL.replace(/^(https?:\/\/)([^/]+)(\/.*)?$/i, '$1$2'),
          },
          portalPageId,
          templateLess,
          disableSSLValidation,
          v7Features,
        });

        if (enableProxyCache) {
          let ttl = +proxyCacheTTL;

          if (!ttl || Number.isNaN(ttl) || ttl < 0) {
            ttl = 10 * 60 * 1000; // 10 minutes
          }

          server.middlewares.use(initProxyCache({ devServer: server, ttl }));
        }

        server.middlewares.use(
          proxyPassMiddleware({
            devServer: server,
            baseURL: backendBaseURL,
            proxyIgnore: ['/@vite', '/@metricinsights', '/@', baseWithoutTrailingSlash],
            disableSSLValidation,
          }) as any,
        );

        const isIndexRegExp = new RegExp(`^((${base})|/)$`);

        // Get portal page variables from the backend (also, redirect magic)
        server.middlewares.use(initLoadPPData(isIndexRegExp, mi, options));

        const distService =
          distZip !== false
            ? new DistService(
                templateName,
                Object.assign(
                  { backupDir: syncBackupsDir },
                  typeof distZip === 'object'
                    ? { distZipFolder: distZip.outDir, distZipFilename: distZip.outFileName }
                    : undefined,
                ),
              )
            : undefined;

        const eventHandler = new ClientService(server, { distService, miAPI: mi });

        return () => {
          server.middlewares.use(
            initRewriteResponse(
              (url) => {
                return url.endsWith('index.html');
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
