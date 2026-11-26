/**
 * The MI session cookie per MI instance on the browser's side (PP-4840, phase 3).
 *
 * Browsers keep cookies by host, not by port: `metric_insights_session` on `localhost` (and on
 * `<name>.localhost`) was one cookie for every MI instance. After a switch the old instance's session
 * reached the new one, a login there replaced the other's, and two dev servers on different ports
 * logged each other out. The browser now keeps the session of every instance but the default one
 * (`mi.url`) as `metric_insights_session__<host>`; MI and pp-dev's own code see MI's name only.
 *
 * - Towards MI: the request's `Cookie` keeps the session of this instance, under MI's name, and none
 *   of another one.
 * - Towards the browser: a `Set-Cookie` of MI's session is renamed when the headers go out. Until
 *   then pp-dev's code reads it under MI's name; {@link getMiSetCookie} gives it afterwards.
 */
import type { IncomingMessage, OutgoingHttpHeader, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { MI_SESSION_COOKIE } from './helpers/cookie.helper.js';

/** The browser's name of the session cookie of the instance at `url`: MI's for the default instance. */
export function getSessionCookieName(url: string | undefined, defaultUrl: string | undefined): string {
  const host = getHost(url);

  if (!host || host === getHost(defaultUrl)) {
    return MI_SESSION_COOKIE;
  }

  return `${MI_SESSION_COOKIE}__${host.replace(/[^a-z0-9]/g, '_')}`;
}

function getHost(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Whether a cookie of this name is an MI session, of the default instance or of another one. */
function isSessionCookieName(name: string): boolean {
  return name === MI_SESSION_COOKIE || name.startsWith(`${MI_SESSION_COOKIE}__`);
}

/** A request `Cookie` header as MI gets it: the session of `browserName` under MI's name, no other. */
export function toMiCookieHeader(cookieHeader: string, browserName: string): string {
  const pairs: string[] = [];

  for (const pair of cookieHeader.split(';')) {
    const trimmed = pair.trim();

    if (!trimmed) {
      continue;
    }

    const separator = trimmed.indexOf('=');
    const name = separator === -1 ? trimmed : trimmed.slice(0, separator).trim();

    if (!isSessionCookieName(name)) {
      pairs.push(trimmed);
    } else if (name === browserName && separator !== -1) {
      pairs.push(`${MI_SESSION_COOKIE}=${trimmed.slice(separator + 1).trim()}`);
    }
  }

  return pairs.join('; ');
}

/** A `Set-Cookie` header as the browser gets it: MI's session cookie under `browserName`. */
export function toBrowserSetCookie(value: OutgoingHttpHeader, browserName: string): OutgoingHttpHeader {
  const rename = (cookie: string) =>
    cookie.replace(new RegExp(`^(\\s*)${MI_SESSION_COOKIE}(\\s*=)`), `$1${browserName}$2`);

  if (typeof value === 'string') {
    return rename(value);
  }

  return Array.isArray(value) ? value.map((cookie) => rename(String(cookie))) : value;
}

/** The `Set-Cookie` of responses whose MI session cookie was renamed: as pp-dev's code set it. */
const miSetCookies = new WeakMap<ServerResponse, OutgoingHttpHeader>();

/**
 * The response's `Set-Cookie` under MI's names, also once the headers were sent with the browser's:
 * what code that looks at a response after it ended (the proxy cache) reads.
 */
export function getMiSetCookie(res: ServerResponse): OutgoingHttpHeader | undefined {
  return miSetCookies.get(res) ?? res.getHeader('set-cookie');
}

/** Renames MI's session cookie in a `Set-Cookie` header of `headers` (writeHead's argument). */
function renameInHeaders(
  headers: OutgoingHttpHeaders | OutgoingHttpHeader[] | undefined,
  browserName: string,
): OutgoingHttpHeaders | OutgoingHttpHeader[] | undefined {
  if (!headers) {
    return headers;
  }

  if (Array.isArray(headers)) {
    // Raw: name, value, name, value…
    return headers.map((value, index) =>
      index % 2 === 1 && String(headers[index - 1]).toLowerCase() === 'set-cookie'
        ? toBrowserSetCookie(value, browserName)
        : value,
    );
  }

  const renamed: OutgoingHttpHeaders = { ...headers };

  for (const key of Object.keys(renamed)) {
    if (key.toLowerCase() === 'set-cookie' && renamed[key] !== undefined) {
      renamed[key] = toBrowserSetCookie(renamed[key], browserName);
    }
  }

  return renamed;
}

/**
 * First in the chain, in every environment: also the default one must not send MI the session of
 * another instance, which the browser still holds.
 */
export function createSessionCookieMiddleware(browserName: string = MI_SESSION_COOKIE) {
  return (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void => {
    if (typeof req.headers.cookie === 'string') {
      const cookie = toMiCookieHeader(req.headers.cookie, browserName);

      if (cookie) {
        req.headers.cookie = cookie;
      } else {
        delete req.headers.cookie;
      }
    }

    if (browserName !== MI_SESSION_COOKIE) {
      const originalWriteHead = res.writeHead;

      // Every way the headers go out passes here: Node calls writeHead for headers that write()
      // or end() send implicitly.
      res.writeHead = function (this: ServerResponse, ...args: unknown[]) {
        const stored = this.getHeader('set-cookie');

        if (stored !== undefined) {
          miSetCookies.set(this, stored);
          this.setHeader('set-cookie', toBrowserSetCookie(stored, browserName));
        }

        // writeHead(status, headers) or writeHead(status, message, headers).
        const headersAt = typeof args[1] === 'string' ? 2 : 1;

        if (args[headersAt] && typeof args[headersAt] === 'object') {
          const given = args[headersAt] as OutgoingHttpHeaders | OutgoingHttpHeader[];
          const givenSetCookie: OutgoingHttpHeader | undefined = Array.isArray(given)
            ? given
                .filter((_, index) => index % 2 === 1 && String(given[index - 1]).toLowerCase() === 'set-cookie')
                .flatMap((value) => (Array.isArray(value) ? value : [String(value)]))
            : Object.entries(given).find(([key]) => key.toLowerCase() === 'set-cookie')?.[1];

          // Given here, it is what the response sends (Node takes it over a stored one).
          if (givenSetCookie !== undefined && (!Array.isArray(givenSetCookie) || givenSetCookie.length > 0)) {
            miSetCookies.set(this, givenSetCookie);
          }

          args[headersAt] = renameInHeaders(given, browserName);
        }

        return (originalWriteHead as (...a: unknown[]) => ServerResponse).apply(this, args);
      } as ServerResponse['writeHead'];
    }

    next();
  };
}
