import type { IncomingMessage } from 'node:http';
import type { RequestHandler } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `host[:port]` as URL normalizes it (lowercased, default port dropped), or `undefined`. */
function normalizeHost(scheme: string, host: string): string | undefined {
  try {
    return new URL(`${scheme}//${host}`).host;
  } catch {
    return undefined;
  }
}

/**
 * Why a browser request to the dev server's own API comes from another site, or `null` when it
 * doesn't.
 *
 * The internal API (users, login, variables, request inspector) and the dev-panel WebSocket act
 * with the developer's MI token: adding a user, replacing the token, saving page variables, syncing
 * the template to MI. Any page open in the browser could otherwise reach them on
 * `localhost:<port>`, with a plain form POST (no CORS preflight) or a WebSocket.
 *
 * Every legitimate caller is a page the dev server serves itself, so its `Origin` is the request's
 * own `Host`. A request with another `Origin` is refused, whatever its method. A state-changing
 * request without `Origin` is refused when `Sec-Fetch-Site` says another site sent it. Requests
 * with neither header (curl, scripts) are not from a browser page and pass.
 */
export function crossOriginReason(req: IncomingMessage): string | null {
  const origin = req.headers.origin;
  const host = req.headers.host;

  if (typeof origin === 'string') {
    if (origin === 'null') {
      return 'Origin "null" (a sandboxed or file:// page)';
    }

    let originUrl: URL;

    try {
      originUrl = new URL(origin);
    } catch {
      return `unreadable Origin "${origin}"`;
    }

    const requestHost = host ? normalizeHost(originUrl.protocol, host) : undefined;

    if (!requestHost || originUrl.host !== requestHost) {
      return `Origin ${originUrl.origin} is not this dev server (${host ?? 'no Host'})`;
    }

    return null;
  }

  const fetchSite = req.headers['sec-fetch-site'];

  if (
    !SAFE_METHODS.has((req.method ?? 'GET').toUpperCase()) &&
    typeof fetchSite === 'string' &&
    fetchSite !== 'same-origin' &&
    fetchSite !== 'none'
  ) {
    return `sent from a ${fetchSite} page`;
  }

  return null;
}

/** Express middleware: answers a cross-origin request with 403 before any route or body parser. */
export const originGuard: RequestHandler = (req, res, next) => {
  const reason = crossOriginReason(req);

  if (!reason) {
    next();

    return;
  }

  res.status(403).json({ error: `Blocked by pp-dev: ${reason}.` });
};
