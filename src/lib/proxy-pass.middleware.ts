import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import { getOriginRegExp, rewriteDataPagePathForV7Proxy, urlReplacer, urlPathReplacer } from './helpers/url.helper.js';
import { ViteDevServer } from 'vite';
import { Express } from 'express';
import { createLogger } from './logger.js';
import { colors } from './helpers/color.helper.js';
import { ServerResponse, IncomingMessage } from 'http';
import { StringDecoder } from 'node:string_decoder';
import type { Socket } from 'node:net';
import { tokenLoginFunction } from './helpers/login.helper';
import { isSecureRequest, rewriteSetCookieHeader } from './helpers/cookie.helper.js';
import { MiAPI } from './pp.middleware';
import { SavedUser, UserRegistry, getUserNameFromHost, getUserOrigin, userRegistry } from './user-registry.js';
import {
  SessionUserTracker,
  withSessionCookie,
  withoutSessionCookie,
  withoutSessionSetCookie,
} from './session-users.js';
import { createSessionCheck } from './mi-identity.js';
import type { Connect } from 'vite';

type NextHandleFunction = Connect.NextHandleFunction;

export interface ProxyOpts {
  rewritePath?: string | string[] | RegExp;

  baseURL: string;

  proxyIgnore?: (string | RegExp)[];

  devServer: ViteDevServer | Express;

  disableSSLValidation?: boolean;

  miAPI: MiAPI;

  /** Local template name (e.g. package name); used with {@link MiAPI.internalPageName} for v7 `/data/page/` proxy rewrites. */
  templateName?: string;

  /** Saved users, picked by the request's host. @default the shared {@link userRegistry} */
  users?: UserRegistry;

  /** Follows session users' logins and expiries. @default one that checks sessions with {@link miAPI} */
  sessionUsers?: SessionUserTracker;
}

const hostOriginRegExp = /^(https?:\/\/)([^/]+)(\/.*)?$/i;

export const PROXY_HEADER = 'X-PP-Proxy';

/**
 * Answers a request whose proxying to MI failed (MI unreachable, a reset connection, …).
 *
 * The stack only goes to the dev server's log. What can still be sent depends on how far the
 * response got: nothing yet gets a 502 with a short message; once headers are out, the connection
 * is cut, so the browser sees a failed load instead of a truncated page that looks complete; an
 * ended response is left alone (writing to it threw `ERR_STREAM_WRITE_AFTER_END`). A WebSocket
 * upgrade hands over a socket instead of a response, which is closed.
 */
export function respondToProxyError(
  err: Error,
  req: IncomingMessage,
  res: ServerResponse | Socket,
  log: (message: string) => void,
): void {
  const summary = `Proxy error: "${err.message}" when trying to "${req.method} ${req.url}"`;

  log(`${summary}\n\n${err.stack ?? ''}`);

  if (typeof (res as ServerResponse).writeHead !== 'function') {
    (res as Socket).destroy();

    return;
  }

  const response = res as ServerResponse;

  if (response.writableEnded || response.destroyed) {
    return;
  }

  if (response.headersSent) {
    response.destroy();

    return;
  }

  response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(summary);
}

/** MI's login page, where the token login form is added. */
const LOGIN_PAGE_REGEXP = /^\/login(?:\/|$)/i;

/** `value` as a JavaScript string literal that can sit in an inline `<script>` (no `</script>` in it). */
function scriptString(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** MI's logout, e.g. `/auth/index/logout?proxyRedirect=%2F`. */
const LOGOUT_PATH_REGEXP = /^\/auth\/(?:index\/)?logout(?:[/?#]|$)/i;

/** The saved user `req` logs out: a logout made on that user's own host. */
function getLoggedOutUser(req: IncomingMessage, users: UserRegistry): SavedUser | undefined {
  if (!LOGOUT_PATH_REGEXP.test(req.url ?? '')) {
    return undefined;
  }

  const name = getUserNameFromHost(req.headers.host);

  return name === undefined ? undefined : users.get(name);
}

/**
 * The host of `mi.url` as a URL has it: lower case, without its scheme's default port, so
 * `https://mi.example.com:443` and `https://mi.example.com` are the same MI.
 */
export function getMiHost(baseURL: string): string {
  try {
    return new URL(baseURL).host;
  } catch {
    return baseURL.replace(hostOriginRegExp, '$2');
  }
}

/**
 * Points an absolute `Location` on the MI host ({@link getMiHost}) at the dev server `req` came to,
 * in its scheme. A relative one, or one to another host, is left as it is.
 */
export function rewriteLocationHeader(location: string, miHost: string, req: IncomingMessage): string {
  const devHost = req.headers.host;
  let target: URL;

  try {
    target = new URL(location);
  } catch {
    return location;
  }

  // Compared as URL hosts: a default port written out on either side (`mi.url` with `:443`, or MI
  // redirecting to `https://mi.example.com:443/…`) is still MI's own host.
  if (!devHost || !/^https?:$/.test(target.protocol) || target.host !== miHost.toLowerCase()) {
    return location;
  }

  return location.replace(/^https?:\/\/[^/?#]*/i, `${isSecureRequest(req) ? 'https' : 'http'}://${devHost}`);
}

/** The personal access token each proxied request was sent to MI with. */
const requestBearerTokens = new WeakMap<IncomingMessage, string>();

/**
 * Who each proxied request went to MI as: the saved user (none for the original user) and, for a
 * session user sent from the main host, the MI session the proxy put in its cookies.
 */
const requestIdentities = new WeakMap<IncomingMessage, { user?: SavedUser; sentSession?: string }>();

/** The personal access token the proxy sent `req` to MI with, if it added one. */
export function getRequestBearerToken(req: IncomingMessage): string | undefined {
  return requestBearerTokens.get(req);
}

/** Media types whose streamed payload is safe to run the text interceptor over. */
const TEXTUAL_MEDIA_TYPE_REGEXPS = [
  /^text\//,
  /^application\/(?:[\w.-]+\+)?(?:json|xml)$/,
  /^application\/(?:x-)?(?:java|ecma)script$/,
  // SVG and the like: XML or JSON under another top-level type.
  /^[\w.-]+\/[\w.-]+\+(?:json|xml)$/,
];

function isTextualContentType(contentType: string): boolean {
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();

  return TEXTUAL_MEDIA_TYPE_REGEXPS.some((pattern) => pattern.test(mediaType));
}

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

  return typeof contentType === 'string' && isTextualContentType(contentType);
}

/** From this size on, a text response is rewritten as it arrives instead of as a whole. */
const MAX_BUFFERED_BODY_SIZE = 10 * 1024 * 1024;

/**
 * How a proxied response that isn't an event stream goes to the browser. `responseInterceptor` holds
 * the whole body in memory before the first byte goes out, so only what needs it goes that way:
 *
 * - `pipe`: a binary file (a declared content type that isn't text, JSON, XML or script), untouched.
 *   It went through the text rewrite too, which corrupted one `file-type` didn't recognise.
 * - `stream`: uncompressed text of at least {@link MAX_BUFFERED_BODY_SIZE}, rewritten as it arrives.
 * - `buffer`: everything else, rewritten as a whole: MI's pages get scripts added, and compressed text
 *   has to be decoded first.
 */
export function getResponseHandling(headers: IncomingMessage['headers']): 'pipe' | 'stream' | 'buffer' {
  const contentType = headers['content-type'];

  if (typeof contentType === 'string' && contentType.trim() && !isTextualContentType(contentType)) {
    return 'pipe';
  }

  const contentLength = Number(headers['content-length']);

  return Number.isFinite(contentLength) && contentLength >= MAX_BUFFERED_BODY_SIZE && isRewritableStream(headers)
    ? 'stream'
    : 'buffer';
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

    let waitingForDrain = false;

    // piping handled backpressure for us; writing by hand means honouring it here.
    const flush = (text: string) => {
      if (!text) {
        return;
      }

      const flushed = res.write(interceptor(Buffer.from(text, 'utf8'), 'utf8'));

      if (!flushed && !waitingForDrain) {
        waitingForDrain = true;
        proxyRes.pause();

        res.once('drain', () => {
          waitingForDrain = false;
          proxyRes.resume();
        });
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
    users = userRegistry,
  } = opts;

  if (!baseURL) {
    throw new Error('Base url is required');
  }

  const host = getMiHost(baseURL);
  const origin = baseURL.replace(hostOriginRegExp, '$1$2');

  const fileType = import('file-type');

  const logger = createLogger();

  const sessionUsers = opts.sessionUsers ?? new SessionUserTracker(users, createSessionCheck(miAPI));

  return createProxyMiddleware({
    /**
     * IMPORTANT: avoid res.end being called automatically
     **/
    selfHandleResponse: true, // res.end() will be called internally by responseInterceptor()

    // Keep this a function: with a string or glob filter, http-proxy-middleware runs micromatch -> braces, whose
    // GHSA-vfj7-8cjw-p6xm has no fix and is allowlisted in scripts/audit-all.mjs only because it is unreachable here.
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

    // `selfHandleResponse` skips http-proxy's own response passes (`autoRewrite`, `cookieDomainRewrite`, …):
    // `proxyRes` below rewrites `Set-Cookie` and `Location` itself.
    target: baseURL,
    changeOrigin: true,
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
          proxyReq.setHeader('referer', referer.replace(getOriginRegExp(host), baseURL));
        }

        // A saved user goes as its own token, or (a session user) as the MI session its host's
        // cookies carry; everything else as the original user. A user host with no saved user
        // behind it gets no identity at all.
        const requestUser = users.resolve(req);
        let token: string | undefined;

        if (requestUser?.user) {
          token = requestUser.user.token;
        } else if (requestUser) {
          token = miAPI.personalAccessToken;
        }

        if (token) {
          proxyReq.setHeader('Authorization', `Bearer ${token}`);
          requestBearerTokens.set(req, token);
        } else if (requestUser?.user?.kind === 'session') {
          // A session user goes as its MI session only: a bearer token the page sends would make MI
          // answer as that token's owner while pp-dev attributes the request to the session user.
          proxyReq.removeHeader('Authorization');
        }

        // MI's regular `Token` header authenticates too: a saved user goes only as its own token or
        // session.
        if (requestUser?.user) {
          proxyReq.removeHeader('Token');
        }

        // A session user as the main host's default user: the main host's cookies hold another
        // session, so send the one the user logged in with on its own host. If that session ended
        // after the request was resolved (while page data loaded, say), send none: never the main
        // host's own, which would make MI answer as you while pp-dev files it under the user.
        const sessionUser = requestUser?.user?.kind === 'session' ? requestUser.user : undefined;
        let sentSession: string | undefined;

        if (sessionUser && getUserNameFromHost(req.headers.host) !== sessionUser.name) {
          sentSession = sessionUser.session;

          const cookie = sentSession
            ? withSessionCookie(req.headers.cookie, sentSession)
            : withoutSessionCookie(req.headers.cookie);

          if (cookie) {
            proxyReq.setHeader('cookie', cookie);
          } else {
            proxyReq.removeHeader('cookie');
          }
        }

        // The response is handled as whoever the request went as, even if the default user
        // changes before MI answers.
        requestIdentities.set(req, { user: requestUser?.user, sentSession });

        // A `304` would make the browser reuse the copy it cached before (possibly for another
        // session, or by a pp-dev version that still let it cache), so always fetch the full body.
        proxyReq.removeHeader('if-none-match');
        proxyReq.removeHeader('if-modified-since');

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
          )} ${proxyReq.protocol}//${proxyReq.host}${proxyReq.path}${
            requestUser?.user ? ` ${colors.blue('as')} ${colors.yellow(requestUser.user.name)}` : ''
          }`,
        );

        // The browser going away aborts the upstream request. (Not `req.once('close')`: that can fire
        // before MI answers.) Keep-alive reuses `req.socket` for many requests, so the listener goes
        // as soon as this request is done; otherwise each would hold its `proxyReq` until the
        // connection closes.
        const { socket } = req;
        const abortUpstream = () => {
          setTimeout(() => {
            if (!proxyReq.destroyed) {
              proxyReq.destroy();
            }
          }, 200);
        };

        socket.once('close', abortUpstream);
        proxyReq.once('close', () => socket.off('close', abortUpstream));

        return proxyReq;
      },
      proxyRes: (serverRes, req, res) => {
        // `selfHandleResponse` skips http-proxy's own cookie rewriting, and both response paths below
        // copy headers from `serverRes`, so the cookies are fixed here once.
        if (serverRes.headers['set-cookie']) {
          serverRes.headers['set-cookie'] = rewriteSetCookieHeader(
            serverRes.headers['set-cookie'],
            isSecureRequest(req),
          );
        }

        // A redirect MI makes to itself (`https://<mi-host>/…`) must stay on the dev server.
        if (serverRes.headers.location) {
          serverRes.headers.location = rewriteLocationHeader(serverRes.headers.location, host, req);
        }

        // Logging out as a saved user ends its session (or token) at MI, as it would anywhere else.
        // The user is then gone: drop it, and send the tab back to the default user on the main host.
        const loggedOutUser = getLoggedOutUser(req, users);
        const identity = requestIdentities.get(req);

        if (loggedOutUser) {
          serverRes.resume();

          const headers: Record<string, string | string[]> = { 'cache-control': 'no-store' };

          // Only the user the logout was sent as is logged out. One removed and added again while
          // the logout was in flight keeps its registration, cache and host cookie.
          if (identity?.user === loggedOutUser) {
            users.remove(loggedOutUser.name);

            logger.info(
              `${colors.blue('Logged out user')} ${colors.yellow(loggedOutUser.name)}, back to the main host`,
            );

            // MI's own Set-Cookie clears the session cookie the user's host still holds.
            if (serverRes.headers['set-cookie']) {
              headers['set-cookie'] = serverRes.headers['set-cookie'];
            }
          }

          const fetchMode = req.headers['sec-fetch-mode'];

          if (!fetchMode || fetchMode === 'navigate') {
            res.writeHead(302, { ...headers, location: `${getUserOrigin(req)}/` });
          } else {
            res.writeHead(204, headers);
          }

          res.end();

          return;
        }

        const savedUser = identity?.user;
        // Whether the MI session MI hands out here may reach the browser.
        let passSession = true;

        if (savedUser && users.get(savedUser.name) !== savedUser) {
          // Removed, or removed and added again, while the request was in flight: its session belongs
          // to the old registration and must not replace the one its host holds now.
          passSession = false;
        } else if (savedUser) {
          let leftBehind = false;

          if (savedUser.kind === 'session') {
            // Decided before the tracker looks at the response, which may change the user's session.
            leftBehind = sessionUsers.isLeftBehindRequest(savedUser, req, identity?.sentSession);
            sessionUsers.observe(savedUser, req, serverRes, identity?.sentSession);
          }

          // As the main host's default user (token or session), the browser keeps the main host's
          // own session, which is yours again once you are the default; on the user's host, the
          // newer one it logged in with since this request left.
          passSession = getUserNameFromHost(req.headers.host) === savedUser.name && !leftBehind;
        }

        if (!passSession) {
          const otherCookies = withoutSessionSetCookie(serverRes.headers['set-cookie']);

          // Deleted rather than left `undefined`: the interceptors copy every header key.
          if (otherCookies) {
            serverRes.headers['set-cookie'] = otherCookies;
          } else {
            delete serverRes.headers['set-cookie'];
          }
        }

        // MI responses depend on the session, so the browser must not reuse one after a login or
        // logout: Safari kept serving portal page images from its own cache after logging in again
        // and drew them as black boxes. Repeat loads are still fast, since the proxy cache serves
        // them and is dropped on every session change.
        serverRes.headers['cache-control'] = 'no-store';
        delete serverRes.headers['expires'];
        delete serverRes.headers['pragma'];

        const rewriteUrls = (data: Buffer, encoding: BufferEncoding) =>
          Buffer.from(urlReplacer(host, req.headers.host ?? '', data.toString(encoding)), encoding);

        if (
          serverRes.headers['content-type']?.includes('text/event-stream') ||
          (serverRes.headers['transfer-encoding']?.includes('chunked') &&
            serverRes.headers['x-accel-buffering'] === 'no')
        ) {
          logger.info(`${colors.blue('Start streaming for request:')} ${colors.green(req.method)} ${req.url}`);

          return streamResponseInterceptor(rewriteUrls)(serverRes, req, res);
        }

        const handling = getResponseHandling(serverRes.headers);

        if (handling !== 'buffer') {
          return streamResponseInterceptor(handling === 'stream' ? rewriteUrls : undefined)(serverRes, req, res);
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

              const slice = response.slice(0, 100);

              // The token login sets the original user's token, so a saved user's host goes without it.
              // Only MI's login page gets it: on every other page it watched the whole DOM for a login
              // form that never came, for as long as the page stayed open.
              if (
                LOGIN_PAGE_REGEXP.test(reqUrl.pathname) &&
                (slice.includes('<html') ||
                  slice.includes('<body') ||
                  slice.includes('<head') ||
                  slice.includes('html>')) &&
                !getUserNameFromHost(req.headers.host)
              ) {
                response += `<script>(${tokenLoginFunction.toString()})(${scriptString(host)})</script>`;
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
        respondToProxyError(err, req, res as ServerResponse | Socket, (message) => logger.error(message));
      },
    },
  }) as unknown as NextHandleFunction;
}

export default initProxy;
