import type { IncomingMessage } from 'http';
import type { TLSSocket } from 'tls';

/**
 * Whether the browser reached the dev server over HTTPS (directly or behind a TLS-terminating proxy).
 */
export function isSecureRequest(req: IncomingMessage): boolean {
  if ((req.socket as TLSSocket | undefined)?.encrypted) {
    return true;
  }

  const forwardedProto = req.headers?.['x-forwarded-proto'];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;

  return typeof proto === 'string' && proto.split(',', 1)[0].trim().toLowerCase() === 'https';
}

/**
 * Makes a single `Set-Cookie` value from the MI instance storable by the browser on the local dev origin.
 *
 * - `Domain` is always dropped: it names the MI host, so no browser would store it for `localhost`.
 * - On a plain-HTTP dev server `Secure` is dropped too. Chrome and Firefox accept `Secure` cookies on
 *   `http://localhost`, but Safari (WebKit) rejects them, so the MI session cookie never got stored and
 *   the regular login form looped back to the login page. `SameSite=None` requires `Secure`, so it is
 *   downgraded to `Lax` in the same case.
 */
export function rewriteSetCookie(cookie: string, secureRequest: boolean): string {
  const [pair, ...attributes] = cookie.split(';');

  const rewritten = attributes
    .map((attribute) => attribute.trim())
    .filter((attribute) => {
      if (!attribute) {
        return false;
      }

      const name = attribute.split('=', 1)[0].trim().toLowerCase();

      if (name === 'domain') {
        return false;
      }

      return secureRequest || name !== 'secure';
    })
    .map((attribute) => {
      if (!secureRequest && /^samesite\s*=\s*none$/i.test(attribute)) {
        return 'SameSite=Lax';
      }

      return attribute;
    });

  return [pair.trim(), ...rewritten].join('; ');
}

/**
 * Applies {@link rewriteSetCookie} to a `Set-Cookie` header value as Node exposes it.
 */
export function rewriteSetCookieHeader<T extends string | string[] | undefined>(value: T, secureRequest: boolean): T {
  if (value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((cookie) => rewriteSetCookie(cookie, secureRequest)) as T;
  }

  return rewriteSetCookie(value, secureRequest) as T;
}
