import { HtmlTagDescriptor, IndexHtmlTransformResult, Plugin } from 'vite';
import proxyPassMiddleware from './lib/proxy-pass.middleware.js';
import { MiAPI, Headers } from './lib/pp.middleware.js';
import * as http from 'http';
import { urlReplacer } from './lib/helpers/url.helper.js';
import * as path from 'path';
import { PACKAGE_NAME, VERSION } from './constants.js';

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

const PACKAGE_IMPORT = `${PACKAGE_NAME}/client`;
const CLIENT_PATH = `/${PACKAGE_IMPORT}`;

function vitePPDev(options: VitePPDevOptions): Plugin {
  const { templateName, templateLess = false, miHudLess = false, backendBaseURL, portalPageId } = options || {};

  // Avoid server caching for index.html file when first loading
  let isFirstRequest = true;

  return {
    name: 'vite-pp-dev',
    apply: 'serve',
    transformIndexHtml: (html, ctx) => {
      const result: IndexHtmlTransformResult = { html, tags: [] };

      const getPackageAssetsUrl = (assetPath: string) => {
        return path.posix.join(ctx.server?.config.base || '', `/${PACKAGE_NAME}/assets${assetPath}`);
      };

      result.tags.push(
        {
          tag: 'script',
          injectTo: 'head',
          attrs: {
            type: 'module',
            src: path.posix.join(ctx.server?.config.base || '', CLIENT_PATH),
          },
        },
        {
          tag: 'link',
          injectTo: 'head',
          attrs: {
            rel: 'stylesheet',
            href: getPackageAssetsUrl('/client/css/client.css?inline'),
          },
        },
        {
          tag: 'div',
          injectTo: 'body',
          attrs: {
            class: 'pp-dev-info',
          },
          children: [
            {
              tag: 'span',
              children: [
                {
                  tag: 'a',
                  attrs: {
                    href: `https://www.npmjs.com/package/${PACKAGE_NAME}/v/${VERSION}`,
                    target: '_blank',
                  },
                  children: `<b>${PACKAGE_NAME}</b>: <b style="color: orange">${VERSION}</b>`,
                },
                { tag: 'span', children: '; ' },
                ...([
                  backendBaseURL
                    ? {
                        tag: 'span',
                        children: `Backend URL: <a href="!!${backendBaseURL}" target="_blank">!!${backendBaseURL}</a>;`,
                      }
                    : null,
                  {
                    tag: 'span',
                    children: ` Template mode: ${
                      templateLess || !backendBaseURL || Number.isNaN(+portalPageId!)
                        ? `<b style="color: red">Disabled</b>;`
                        : `<b style="color: green">Enabled</b>;`
                    } `,
                  },
                  backendBaseURL && !Number.isNaN(+portalPageId!)
                    ? {
                        tag: 'span',
                      // eslint-disable-next-line max-len
                        children: `Portal page ID: <a href="!!${backendBaseURL}/admin/page/edit/id/${portalPageId}" target="_blank">${portalPageId}</a>;`,
                      }
                    : null,
                  miHudLess ? `MI HUD: <b style="color: red">Disabled</b>;` : null,
                ].filter((v) => !!v) as HtmlTagDescriptor[]),
              ],
            },
          ],
        },
      );

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
    resolveId: async function (source, importer, options) {
      if (source === CLIENT_PATH) {
        return await this.resolve(PACKAGE_IMPORT, importer, {
          skipSelf: true,
          ...options,
        });
      } else if (source.startsWith(`/${PACKAGE_NAME}/assets`)) {
        return await this.resolve(source.replace('/', ''), importer, {
          skipSelf: true,
          ...options,
        });
      }
    },
    configureServer: (server) => {
      let base = server.config.base;

      if (!base.endsWith('/')) {
        base += '/';
      }

      const baseWithoutTrailingSlash = base.substring(0, base.lastIndexOf('/') - 1);

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

        server.middlewares.use(
          proxyPassMiddleware({
            baseURL: backendBaseURL,
            proxyIgnore: ['/@vite', '/@metricinsights'],
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
        }
      }
    },
  };
}

export default vitePPDev;
