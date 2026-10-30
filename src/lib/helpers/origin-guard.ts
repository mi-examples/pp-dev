import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { RequestHandler } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `server.allowedHosts`: lowercased host names, `.domain` for a domain and its subdomains, or `true`. */
export type AllowedHosts = readonly string[] | true;

/**
 * What a `Host` header names: an IP address, a hostname (lowercased), or `undefined` when
 * unreadable. An IP address is its own kind, not a hostname: a name such as `ip` must not pass
 * for one.
 */
function readHostHeader(host: string): { ip: true } | { hostname: string } | undefined {
  const trimmed = host.trim().toLowerCase();

  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');

    return end > 0 && isIP(trimmed.slice(1, end)) === 6 ? { ip: true } : undefined;
  }

  const hostname = trimmed.replace(/:\d*$/, '');

  if (!hostname || hostname.includes(':')) {
    return undefined;
  }

  return isIP(hostname) === 4 ? { ip: true } : { hostname };
}

function matchesAllowedHost(hostname: string, allowedHosts: readonly string[]): boolean {
  return allowedHosts.some(
    (allowed) =>
      allowed === hostname ||
      (allowed.startsWith('.') && (allowed.slice(1) === hostname || hostname.endsWith(allowed))),
  );
}

/**
 * Whether the dev server answers a request with this `Host`, as Vite's own check in `pp-dev`
 * (`server.allowedHosts`): an IP address, `localhost`, a `*.localhost` name, or one of
 * `allowedHosts`. Any other name is how DNS rebinding reaches it: a page on `evil.example:3000`,
 * whose name the attacker then points at 127.0.0.1, is same-origin with the dev server, so the
 * {@link crossOriginReason} check lets it through; the `Host` it sends is still `evil.example`.
 * No `Host` (HTTP/1.0, scripts) is not from a browser and passes.
 */
export function isHostAllowed(host: string | undefined, allowedHosts: AllowedHosts): boolean {
  if (host === undefined || allowedHosts === true) {
    return true;
  }

  const named = readHostHeader(host);

  if (named === undefined) {
    return false;
  }

  if ('ip' in named) {
    return true;
  }

  const { hostname } = named;

  return hostname === 'localhost' || hostname.endsWith('.localhost') || matchesAllowedHost(hostname, allowedHosts);
}

/** The answer to a request {@link isHostAllowed} refuses. */
export function hostNotAllowedMessage(host: string | undefined): string {
  const hostname = JSON.stringify((host ?? '').replace(/:\d*$/, ''));

  return `Blocked by pp-dev: this host (${hostname}) is not allowed. To allow it, add ${hostname} to server.allowedHosts in the pp-dev config.`;
}

/**
 * The names in `allowedHosts` without a leading dot: the hosts whose pages may call the dev server
 * (see {@link crossOriginReason}). `true` names none.
 */
export function exactAllowedHosts(allowedHosts: AllowedHosts): string[] {
  return allowedHosts === true ? [] : allowedHosts.filter((host) => !host.startsWith('.'));
}

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
 * address), pages served on this machine on any port (two pages run by separate local dev servers
 * may need to work together) and pages on a host named in `allowedHosts` without a leading dot: a
 * tunnel that rewrites `Host` to `localhost` leaves its own name in `Origin`. A `.domain` entry
 * doesn't count here: with `.ngrok.app`, any tunnel's page, someone else's too, could act with the
 * developer's token. Any other `Origin` is refused, whatever the method. A state-changing request
 * without `Origin` is refused when `Sec-Fetch-Site` says another site sent it (`same-site` covers
 * other localhost ports). Requests with neither header (curl, scripts) are not from a browser page
 * and pass.
 */
export function crossOriginReason(req: IncomingMessage, allowedHosts: AllowedHosts = []): string | null {
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

    if (isLocalHostname(originUrl.hostname) || exactAllowedHosts(allowedHosts).includes(originUrl.hostname)) {
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
export function createOriginGuard(allowedHosts: AllowedHosts = []): RequestHandler {
  return (req, res, next) => {
    const reason = crossOriginReason(req, allowedHosts);

    if (!reason) {
      next();

      return;
    }

    res.status(403).json({ error: `Blocked by pp-dev: ${reason}.` });
  };
}
