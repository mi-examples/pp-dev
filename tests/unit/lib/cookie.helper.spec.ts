import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { isSecureRequest, rewriteSetCookie, rewriteSetCookieHeader } from '../../../src/lib/helpers/cookie.helper.js';

/**
 * Regression tests for PP-4238: the regular login form looped back to the login page in Safari.
 *
 * MI sets its session cookie with `Secure`. Chrome and Firefox store `Secure` cookies on
 * `http://localhost`, Safari (WebKit) does not, so the session never reached the browser and every
 * request after the login was unauthorized.
 */

const MI_SESSION_COOKIE =
  'metric_insights_session=abc123; expires=Wed, 29 Sep 2027 07:13:13 GMT; Max-Age=31536000; path=/; secure; httponly; samesite=lax';

function makeReq({ encrypted, forwardedProto }: { encrypted?: boolean; forwardedProto?: string | string[] } = {}) {
  return {
    socket: { encrypted },
    headers: forwardedProto === undefined ? {} : { 'x-forwarded-proto': forwardedProto },
  } as unknown as IncomingMessage;
}

describe('cookie helper', () => {
  describe('rewriteSetCookie', () => {
    it('drops Secure from the MI session cookie on a plain-HTTP dev server', () => {
      expect(rewriteSetCookie(MI_SESSION_COOKIE, false)).toBe(
        'metric_insights_session=abc123; expires=Wed, 29 Sep 2027 07:13:13 GMT; Max-Age=31536000; path=/; httponly; samesite=lax',
      );
    });

    it('keeps Secure when the dev server itself is served over HTTPS', () => {
      expect(rewriteSetCookie(MI_SESSION_COOKIE, true)).toBe(MI_SESSION_COOKIE);
    });

    it('downgrades SameSite=None to Lax once Secure is gone', () => {
      expect(rewriteSetCookie('sid=1; Path=/; Secure; SameSite=None', false)).toBe('sid=1; Path=/; SameSite=Lax');
      expect(rewriteSetCookie('sid=1; Path=/; Secure; SameSite=None', true)).toBe(
        'sid=1; Path=/; Secure; SameSite=None',
      );
    });

    it('always drops the MI Domain attribute', () => {
      expect(rewriteSetCookie('sid=1; Domain=ca-burns-dev.metricinsights.com; Path=/', true)).toBe('sid=1; Path=/');
      expect(rewriteSetCookie('sid=1; domain=.metricinsights.com; Path=/', false)).toBe('sid=1; Path=/');
    });

    it('does not touch the cookie value, even when it looks like an attribute', () => {
      expect(rewriteSetCookie('note=Secure; Path=/; Secure', false)).toBe('note=Secure; Path=/');
      expect(rewriteSetCookie('Domain=x; Path=/', false)).toBe('Domain=x; Path=/');
    });

    it('leaves attributes whose name only starts with "secure" alone', () => {
      expect(rewriteSetCookie('sid=1; SecureFlag=1; Secure', false)).toBe('sid=1; SecureFlag=1');
    });
  });

  describe('rewriteSetCookieHeader', () => {
    it('rewrites every cookie in a multi-value header', () => {
      expect(rewriteSetCookieHeader(['a=1; Secure', 'b=2; Path=/; Secure; HttpOnly'], false)).toEqual([
        'a=1',
        'b=2; Path=/; HttpOnly',
      ]);
    });

    it('passes a missing header through', () => {
      expect(rewriteSetCookieHeader(undefined, false)).toBeUndefined();
    });
  });

  describe('isSecureRequest', () => {
    it('is false for a plain-HTTP request', () => {
      expect(isSecureRequest(makeReq())).toBe(false);
    });

    it('is true for a TLS socket', () => {
      expect(isSecureRequest(makeReq({ encrypted: true }))).toBe(true);
    });

    it('honours X-Forwarded-Proto from a TLS-terminating proxy', () => {
      expect(isSecureRequest(makeReq({ forwardedProto: 'https' }))).toBe(true);
      expect(isSecureRequest(makeReq({ forwardedProto: 'https, http' }))).toBe(true);
      expect(isSecureRequest(makeReq({ forwardedProto: 'http' }))).toBe(false);
    });
  });
});
