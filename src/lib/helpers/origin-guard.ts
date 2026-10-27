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

/** This machine: `localhost`, a `*.localhost` name (saved users' hosts), or a loopback address. */
function isLocalHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
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
 * Allowed callers are the dev server's own pages (`Origin` is the request's `Host`, also on a LAN
 * address) and pages served on this machine on any port: two pages run by separate local dev
 * servers may need to work together. Any other `Origin` is refused, whatever the method. A
 * state-changing request without `Origin` is refused when `Sec-Fetch-Site` says another site sent
 * it (`same-site` covers other localhost ports). Requests with neither header (curl, scripts) are
 * not from a browser page and pass.
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

    if (isLocalHostname(originUrl.hostname)) {
      return null;
    }

    const requestHost = host ? normalizeHost(originUrl.protocol, host) : undefined;

    if (!requestHost || originUrl.host !== requestHost) {
      return `Origin ${originUrl.origin} is neither this dev server (${host ?? 'no Host'}) nor this machine`;
    }

    return null;
  }

  const fetchSite = req.headers['sec-fetch-site'];

  if (!SAFE_METHODS.has((req.method ?? 'GET').toUpperCase()) && fetchSite === 'cross-site') {
    return 'sent from a cross-site page';
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
