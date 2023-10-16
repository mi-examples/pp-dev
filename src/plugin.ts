import { IndexHtmlTransformResult, Plugin } from 'vite';
import proxyPassMiddleware from './lib/proxy-pass.middleware.js';
import { MiAPI } from './lib/pp.middleware.js';
import { cutUrlParams, urlReplacer } from './lib/helpers/url.helper.js';
import { ClientService } from './lib/client.service.js';
import { initProxyCache } from './lib/proxy-cache.middleware.js';
import { DistService } from './lib/dist.service.js';
import { initRewriteResponse } from './lib/rewrite-response.middleware.js';
import { initPPRedirect } from './lib/pp-redirect.middleware.js';
import { initLoadPPData } from './lib/load-pp-data.middleware.js';

export interface VitePPDevOptions {
  backendBaseURL?: string;
  portalPageId?: number;
  templateName: string;
  templateLess?: boolean;
  miHudLess?: boolean;
  enableProxyCache?: boolean;
  proxyCacheTTL?: number;
}

function vitePPDev(options: VitePPDevOptions): Plugin {
  const {
    templateName,
    templateLess = false,
    backendBaseURL,
    miHudLess = false,
    portalPageId,
    enableProxyCache = true,
    proxyCacheTTL = 10 * 60 * 1000,
  } = options || {};

  // Avoid server caching for index.html file when first loading
  let isFirstRequest = true;

  return {
    name: 'vite-pp-dev',
    apply: 'serve',
    config: (config) => {
      config.clientInjectionPlugin = { backendBaseURL, portalPageId, templateLess };

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
          }) as any,
        );

        const isIndexRegExp = new RegExp(`^((${base})|/)$`);

        // Get portal page variables from the backend (also, redirect magic)
        server.middlewares.use(initLoadPPData(isIndexRegExp, mi, options));

        server.middlewares.use(
          initRewriteResponse(
            (url) => {
              return isIndexRegExp.test(cutUrlParams(url));
            },
            (response, req) => {
              return Buffer.from(urlReplacer(baseUrlHost, req.headers.host ?? '', mi.buildPage(response, miHudLess)));
            },
          ),
        );

        const distService = new DistService(templateName);
        const eventHandler = new ClientService(server, { distService, miAPI: mi });
      }
    },
  };
}

export default vitePPDev;
