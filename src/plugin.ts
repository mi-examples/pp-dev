import { IndexHtmlTransformResult, Plugin } from 'vite';
import proxyPassMiddleware from './lib/proxy-pass.middleware.js';
import { MiAPI, Headers } from './lib/pp.middleware.js';
import * as http from 'http';
import { urlReplacer } from './lib/helpers/url.helper.js';
import { ClientService } from './lib/client.service.js';
import { initProxyCache } from './lib/proxy-cache.middleware.js';

export interface VitePPDevOptions {
  backendBaseURL?: string;
  portalPageId?: number;
  templateName: string;
  templateLess?: boolean;
  miHudLess?: boolean;
}

const redirect = (res: http.ServerResponse, url: string, statusCode?: number) => {
  res.setHeader('location', url);
  res.statusCode = statusCode || 302;

  res.end();
};

function vitePPDev(options: VitePPDevOptions): Plugin {
  const { templateName, templateLess = false, miHudLess = false, backendBaseURL, portalPageId } = options || {};

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

      // Redirect from `/` and `/pt/${templateName}` and `${base}` (without training slash) to portal page address
      server.middlewares.use(function (req, res, next) {
        if (req.url === '/' || req.url === `/pt/${templateName}` || req.url === baseWithoutTrailingSlash) {
          return redirect(res, base, 302);
        }

        next();
      });

      if (backendBaseURL) {
        const baseUrlHost = new URL(backendBaseURL).host;

        const mi = new MiAPI(backendBaseURL, {
          headers: { host: baseUrlHost, referer: backendBaseURL },
        });

        server.middlewares.use(initProxyCache({ viteDevServer: server, ttl: 10 * 60 * 1000 }));

        server.middlewares.use(
          proxyPassMiddleware({
            viteDevServer: server,
            baseURL: backendBaseURL,
            proxyIgnore: ['/@vite', '/@metricinsights', '/@', baseWithoutTrailingSlash],
          }) as any,
        );

        if (typeof portalPageId !== 'undefined') {
          const isIndexRegExp = new RegExp(`^((${base})|/)$`);

          // Get portal page variables from the backend (also, redirect magic)
          server.middlewares.use(function (req, res, next) {
            const isNeedTemplateLoad = !(templateLess && miHudLess);
            const isIndexRequest = isIndexRegExp.test(req.url ?? '');

            if (isNeedTemplateLoad && isIndexRequest) {
              const headers = (req.headers ?? {}) as Headers;

              const loadPageData = !templateLess
                ? mi.getPageVariables(portalPageId, headers)
                : mi.getPageTemplate(headers);

              loadPageData
                .then(() => {
                  next();
                })
                .catch((reason) => {
                  if (reason.response) {
                    return redirect(res, `/home?proxyRedirect=${encodeURIComponent('/')}`, 302);
                  }

                  next(reason);
                });
            } else {
              next();
            }
          });

          server.middlewares.use(function (req, res, next) {
            if (isIndexRegExp.test(req.url ?? '')) {
              const end = res.end;

              const buffers: Buffer[] = [];

              res.write = function (body) {
                buffers.push(body);

                return true;
              };

              // eslint-disable-next-line @typescript-eslint/ban-ts-comment
              // @ts-ignore
              res.end = function (chunk: any, encoding: BufferEncoding, cb?: () => void) {
                if (typeof chunk === 'string') {
                  buffers.push(Buffer.from(chunk));
                }

                end.call(
                  this,
                  Buffer.from(
                    urlReplacer(baseUrlHost, req.headers.host ?? '', mi.buildPage(Buffer.concat(buffers), miHudLess)),
                  ),
                  encoding,
                  cb,
                );
              };
            }

            next();
          });

          const eventHandler = new ClientService(server);
          eventHandler.init();
        }
      }
    },
  };
}

export default vitePPDev;
