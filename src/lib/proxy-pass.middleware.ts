import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import { urlReplacer, urlPathReplacer } from './helpers/url.helper.js';
import { ViteDevServer } from 'vite';
import { Express } from 'express';
import { createLogger } from './logger.js';
import { colors } from './helpers/color.helper.js';
import { ServerResponse, IncomingMessage } from 'http';
import { tokenLoginFunction } from './helpers/login.helper';
import { MiAPI } from './pp.middleware';

export interface ProxyOpts {
  rewritePath?: string | string[] | RegExp;

  baseURL: string;

  proxyIgnore?: (string | RegExp)[];

  devServer: ViteDevServer | Express;

  disableSSLValidation?: boolean;

  miAPI: MiAPI;
}

const hostOriginRegExp = /^(https?:\/\/)([^/]+)(\/.*)?$/i;
export const PROXY_HEADER = 'X-PP-Proxy';

// TODO: Implement interceptor for streaming responses
function streamResponseInterceptor(interceptor?: (data: Buffer, encoding: BufferEncoding) => Buffer) {
  return async <T extends IncomingMessage>(proxyRes: T, req: T, res: ServerResponse<T>) => {
    res.setHeader(PROXY_HEADER, 1);

    res.setHeaders(new Map(Object.entries(proxyRes.headers)) as any);

    proxyRes.pipe(res);
  };
}

export function initProxy(opts: ProxyOpts) {
  const { rewritePath = /^\/(?!pt).*/i, baseURL = '', devServer, disableSSLValidation = false, miAPI } = opts;

  if (!baseURL) {
    throw new Error('Base url is required');
  }

  const host = baseURL.replace(hostOriginRegExp, '$2');
  const origin = baseURL.replace(hostOriginRegExp, '$1$2');

  const fileType = import('file-type');

  const logger = createLogger();

  return createProxyMiddleware({
    /**
     * IMPORTANT: avoid res.end being called automatically
     **/
    selfHandleResponse: true, // res.end() will be called internally by responseInterceptor()

    pathFilter: (pathname, req) => {
      if (
        (opts.proxyIgnore || []).some((value) => {
          if (typeof value === 'string') {
            return pathname.startsWith(value);
          } else if (typeof value.test === 'function') {
            return value.test(pathname);
          }

          return true;
        })
      ) {
        // Ignored paths

        return false;
      }

      if (typeof rewritePath === 'string') {
        return pathname.startsWith(rewritePath);
      } else if (Array.isArray(rewritePath)) {
        return rewritePath.some((rP) => pathname.startsWith(rP));
      } else if (typeof rewritePath.test === 'function') {
        return rewritePath.test(pathname);
      }

      return false;
    },

    target: baseURL,
    changeOrigin: true,
    autoRewrite: true,
    cookieDomainRewrite: {
      [host]: 'localhost',
    },
    logger: {
      info: () => {
        //
      },
      log: () => {
        //
      },
      error: () => {
        //
      },
      warn: () => {
        //
      },
    },
    secure: !disableSSLValidation,
    headers: {
      host,
      origin,
    },
    on: {
      proxyReq(proxyReq, req, res) {
        const host = req.headers.host;
        const referer = proxyReq.getHeader('referer');

        logger.info(
          `${colors.blue('Proxies request:')} ${colors.green(req.method)} ${req.url} -> ${colors.green(
            proxyReq.method,
          )} ${proxyReq.protocol}//${proxyReq.host}${proxyReq.path}`,
        );

        if (host && referer && typeof referer === 'string') {
          proxyReq.setHeader('referer', referer.replace(new RegExp(`https?://${host}`), baseURL));
        }

        if (miAPI.personalAccessToken) {
          proxyReq.setHeader('Authorization', `Bearer ${miAPI.personalAccessToken}`);
        }

        req.socket.on('close', () => {
          setTimeout(() => {
            if (!proxyReq.destroyed) {
              proxyReq.destroy();
            }
          }, 200);
        });

        return proxyReq;
      },
      proxyRes: (serverRes, req, res) => {
        if (
          serverRes.headers['content-type']?.includes('text/event-stream') ||
          (serverRes.headers['transfer-encoding']?.includes('chunked') &&
            serverRes.headers['x-accel-buffering'] === 'no')
        ) {
          logger.info(`${colors.blue('Start streaming for request:')} ${colors.green(req.method)} ${req.url}`);

          const streamInterceptor = streamResponseInterceptor((data, encoding) => {
            return Buffer.from(urlReplacer(host, req.headers.host ?? '', data.toString(encoding)), encoding);
          });

          return streamInterceptor(serverRes, req, res);
        }

        const rewriteInterceptor = responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
          res.setHeader(PROXY_HEADER, 1);

          const type = await (await fileType).fileTypeFromBuffer(responseBuffer);

          if (type) {
            return responseBuffer;
          } else {
            let response = responseBuffer.toString('utf8'); // convert buffer to string

            try {
              const reqUrl = new URL(req.url ?? '', `http://${host}`);

              if (reqUrl.searchParams && reqUrl.searchParams.has('proxyRedirect')) {
                const redirectToFunction = function () {
                  const storageKey = 'pp-dev::redirectCount' as const;
                  const lastRedirectKey = 'pp-dev::lastRedirect' as const;

                  let redirectCount = +(localStorage.getItem(storageKey) ?? 0);
                  let lastRedirect = localStorage.getItem(lastRedirectKey);

                  if (Number.isNaN(redirectCount)) {
                    redirectCount = 0;
                  }

                  let url = window.location.href;

                  const func = function () {
                    const params = new URLSearchParams(window.location.search);

                    if (!params.has('proxyRedirect')) {
                      console.debug('No proxyRedirect param. Cleaning up.');
                      localStorage.removeItem(storageKey);

                      return;
                    }

                    if (url !== window.location.href) {
                      url = window.location.href;

                      setTimeout(func, redirectCount < 3 ? 3000 : 5000);
                    } else {
                      window.location.href = params.get('proxyRedirect') as string;
                    }

                    localStorage.setItem(storageKey, `${++redirectCount}`);
                    localStorage.setItem(lastRedirectKey, new Date().toISOString());
                  };

                  setTimeout(func, 3000);
                };

                response += '<script>' + `(${redirectToFunction.toString()})()` + '</script>';
              }

              if (reqUrl.pathname.startsWith('/login')) {
                response += '<script>' + `const host = "${host}";\n(${tokenLoginFunction.toString()})()` + '</script>';
              }
            } catch {
              //
            }

            const reqHost = req.headers.host ?? '';

            // manipulate response and return the result
            return urlPathReplacer('/auth/saml/login', '/login', urlReplacer(host, reqHost, response));
          }
        });

        return rewriteInterceptor(serverRes, req, res);
      },
      error(err, req, res) {
        const errorMessage = `Proxy error: "${err.message}" when trying to "${req.method} ${req.url}"\n\n${err.stack}`;

        logger.error(errorMessage);

        if (res.writable) {
          (res as ServerResponse).writeHead(500, {
            'Content-Type': 'text/plain',
          });
        }

        res.end(errorMessage);
      },
    },
  });
}

export default initProxy;
