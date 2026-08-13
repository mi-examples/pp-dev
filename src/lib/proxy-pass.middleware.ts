import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import { rewriteDataPagePathForV7Proxy, urlReplacer, urlPathReplacer } from './helpers/url.helper.js';
import { ViteDevServer } from 'vite';
import { Express } from 'express';
import { createLogger } from './logger.js';
import { colors } from './helpers/color.helper.js';
import { ServerResponse, IncomingMessage } from 'http';
import { StringDecoder } from 'node:string_decoder';
import { tokenLoginFunction } from './helpers/login.helper';
import { MiAPI } from './pp.middleware';
import type { NextHandleFunction } from 'connect';

export interface ProxyOpts {
  rewritePath?: string | string[] | RegExp;

  baseURL: string;

  proxyIgnore?: (string | RegExp)[];

  devServer: ViteDevServer | Express;

  disableSSLValidation?: boolean;

  miAPI: MiAPI;

  /** Local template name (e.g. package name); used with {@link MiAPI.internalPageName} for v7 `/data/page/` proxy rewrites. */
  templateName?: string;
}

const hostOriginRegExp = /^(https?:\/\/)([^/]+)(\/.*)?$/i;

export const PROXY_HEADER = 'X-PP-Proxy';

/** Content types whose streamed payload is safe to run the text interceptor over. */
const TEXTUAL_CONTENT_TYPE_REGEXP = /^text\/|(?:^|\+)(?:json|xml)\b|\bjavascript\b/i;

/**
 * Longest chunk we hold back while waiting for a line break. A stream that never emits one
 * (or emits very long lines) is flushed once it reaches this size so the client keeps
 * receiving data and memory stays bounded.
 */
const MAX_PENDING_STREAM_CHUNK = 64 * 1024;

/**
 * Streamed bodies are only rewritten when they are plain text we can decode: a
 * `content-encoding` means the bytes are compressed, and a non-textual `content-type` (the
 * `x-accel-buffering: no` path also carries binary downloads) must reach the client untouched.
 */
function isRewritableStream(headers: IncomingMessage['headers']): boolean {
  const contentEncoding = headers['content-encoding'];

  if (typeof contentEncoding === 'string' && contentEncoding.trim() && contentEncoding.trim() !== 'identity') {
    return false;
  }

  const contentType = headers['content-type'];

  return typeof contentType === 'string' && TEXTUAL_CONTENT_TYPE_REGEXP.test(contentType);
}

/**
 * Streams a proxied response to the client, applying {@link interceptor} to the decoded text
 * as it flows. Complete lines are forwarded immediately (an SSE event always ends with a line
 * break, so nothing is delayed) while a trailing partial line is held back, which keeps a
 * replaced value from being split across two chunks and missed.
 */
export function streamResponseInterceptor(interceptor?: (data: Buffer, encoding: BufferEncoding) => Buffer) {
  return async <T extends IncomingMessage>(proxyRes: T, req: T, res: ServerResponse<T>) => {
    const rewrite = interceptor && isRewritableStream(proxyRes.headers);

    res.statusCode = proxyRes.statusCode ?? res.statusCode;

    if (proxyRes.statusMessage) {
      res.statusMessage = proxyRes.statusMessage;
    }

    res.setHeader(PROXY_HEADER, 1);

    for (const [name, value] of Object.entries(proxyRes.headers)) {
      if (value === undefined) {
        continue;
      }

      // The rewritten payload no longer matches the upstream length.
      if (rewrite && name.toLowerCase() === 'content-length') {
        continue;
      }

      res.setHeader(name, value);
    }

    if (!rewrite) {
      proxyRes.pipe(res);

      return;
    }

    // Decodes incrementally so a multi-byte character split across chunks stays intact.
    const decoder = new StringDecoder('utf8');
    let pending = '';

    const flush = (text: string) => {
      if (text) {
        res.write(interceptor(Buffer.from(text, 'utf8'), 'utf8'));
      }
    };

    proxyRes.on('data', (chunk: Buffer) => {
      pending += decoder.write(chunk);

      const lastBreak = pending.lastIndexOf('\n');

      if (lastBreak !== -1) {
        flush(pending.slice(0, lastBreak + 1));
        pending = pending.slice(lastBreak + 1);
      }

      if (pending.length >= MAX_PENDING_STREAM_CHUNK) {
        flush(pending);
        pending = '';
      }
    });

    proxyRes.on('end', () => {
      flush(pending + decoder.end());
      pending = '';
      res.end();
    });

    proxyRes.on('error', () => {
      res.end();
    });
  };
}

export function initProxy(opts: ProxyOpts): NextHandleFunction {
  const {
    rewritePath = /^\/(?!p[tl]).*/i,
    baseURL = '',
    devServer,
    disableSSLValidation = false,
    miAPI,
    templateName,
  } = opts;

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
      info: () => {},
      warn: () => {},
      error: () => {},
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

        if (host && referer && typeof referer === 'string') {
          proxyReq.setHeader('referer', referer.replace(new RegExp(`https?://${host}`), baseURL));
        }

        if (miAPI.personalAccessToken) {
          proxyReq.setHeader('Authorization', `Bearer ${miAPI.personalAccessToken}`);
        }

        const originalUrl = req.url ?? '/';
        const rewritten = rewriteDataPagePathForV7Proxy(
          originalUrl,
          miAPI.v7Features,
          templateName,
          miAPI.internalPageName,
        );

        if (rewritten !== originalUrl) {
          req.url = rewritten;
          (proxyReq as { path?: string }).path = rewritten;
          console.info(
            `${colors.cyan('Rewrites data page to correct internal page name')}: ${colors.yellow(
              originalUrl,
            )} ${colors.blue('→')} ${colors.green(rewritten)}`,
          );
        }

        logger.info(
          `${colors.blue('Proxies request:')} ${colors.green(req.method)} ${req.url} -> ${colors.green(
            proxyReq.method,
          )} ${proxyReq.protocol}//${proxyReq.host}${proxyReq.path}`,
        );

        // Keep-alive reuses `req.socket`; each proxied request adds one listener until the
        // socket closes once. Use `socket.once('close')` — the socket emits `close` at most
        // once, so this matches `on` without retaining duplicate handlers. setMaxListeners(0)
        // avoids MaxListenersExceeded when many proxied requests share one connection.
        // (Do not use `req.once('close')`: that can fire too early vs upstream response.)
        req.socket.setMaxListeners(0);
        req.socket.once('close', () => {
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

          const type = await (await fileType).fileTypeFromBuffer(responseBuffer as unknown as Uint8Array);

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
                //disable cache
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
              }

              const slice = response.slice(0, 100);

              if (
                slice.includes('<html') ||
                slice.includes('<body') ||
                slice.includes('<head') ||
                slice.includes('html>')
              ) {
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
  }) as unknown as NextHandleFunction;
}

export default initProxy;
