import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createSessionCookieMiddleware,
  getMiSetCookie,
  getSessionCookieName,
  toMiCookieHeader,
} from '../../../src/lib/session-cookie.middleware.js';
import { redactRequestHeaders, redactResponseHeaders } from '../../../src/lib/request-capture.middleware.js';

/** PP-4840 phase 3: the MI session cookie per MI instance on the browser's side. */

const NAMED = 'metric_insights_session__staging_example_com';

describe('getSessionCookieName', () => {
  it("keeps MI's name for the default instance, whatever the path or case of its URL", () => {
    expect(getSessionCookieName('https://mi.example.com', 'https://mi.example.com')).toBe('metric_insights_session');
    expect(getSessionCookieName('https://MI.example.com/', 'https://mi.example.com/x')).toBe('metric_insights_session');
    // No URL to tell: as before.
    expect(getSessionCookieName(undefined, 'https://mi.example.com')).toBe('metric_insights_session');
  });

  it('names the session of another instance after its host, port included', () => {
    expect(getSessionCookieName('https://staging.example.com', 'https://mi.example.com')).toBe(NAMED);
    expect(getSessionCookieName('https://mi.example.com:8443', 'https://mi.example.com')).toBe(
      'metric_insights_session__mi_example_com_8443',
    );
    // Without a default instance, every instance has a name of its own.
    expect(getSessionCookieName('https://staging.example.com', undefined)).toBe(NAMED);
  });
});

describe('toMiCookieHeader', () => {
  it("gives MI this instance's session under MI's name, and no other instance's", () => {
    expect(
      toMiCookieHeader(`a=1; metric_insights_session=DEFAULT; ${NAMED}=STAGING; ${NAMED}_8443=OTHER; b=2`, NAMED),
    ).toBe('a=1; metric_insights_session=STAGING; b=2');
  });

  it("drops the other instances' sessions in the default one too", () => {
    expect(toMiCookieHeader(`metric_insights_session=DEFAULT; ${NAMED}=STAGING`, 'metric_insights_session')).toBe(
      'metric_insights_session=DEFAULT',
    );
  });

  it('sends no session for an instance the browser has none of', () => {
    expect(toMiCookieHeader('metric_insights_session=DEFAULT; a=1', NAMED)).toBe('a=1');
  });
});

describe('createSessionCookieMiddleware', () => {
  /** A server with the middleware in front of `handler`; answers with what the browser got. */
  async function serve(browserName: string, handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
    const middleware = createSessionCookieMiddleware(browserName);
    const server = http.createServer((req, res) => middleware(req, res, () => handler(req, res)));

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const port = (server.address() as AddressInfo).port;

    try {
      return await new Promise<http.IncomingMessage>((resolve, reject) => {
        http
          .request(
            { host: '127.0.0.1', port, headers: { cookie: `metric_insights_session=DEFAULT; ${NAMED}=S` } },
            (res) => {
              res.resume();
              res.on('end', () => resolve(res));
            },
          )
          .on('error', reject)
          .end();
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("renames MI's session cookie when the headers go out, and keeps MI's name for pp-dev until then", async () => {
    let seen: { cookie?: string; afterEnd?: unknown } = {};

    const res = await serve(NAMED, (req, response) => {
      response.setHeader('set-cookie', ['metric_insights_session=NEW; Path=/', 'other=1']);
      response.on('finish', () => {
        seen.afterEnd = getMiSetCookie(response);
      });
      seen.cookie = req.headers.cookie;
      response.end('ok');
    });

    expect(seen.cookie).toBe('metric_insights_session=S');
    expect(res.headers['set-cookie']).toEqual([`${NAMED}=NEW; Path=/`, 'other=1']);
    // What the proxy cache reads once the response finished.
    expect(seen.afterEnd).toEqual(['metric_insights_session=NEW; Path=/', 'other=1']);
    seen = {};
  });

  it.each([
    ['an object', (res: http.ServerResponse) => res.writeHead(200, { 'Set-Cookie': 'metric_insights_session=NEW' })],
    [
      'a message and an object',
      (res: http.ServerResponse) => res.writeHead(200, 'OK', { 'set-cookie': ['metric_insights_session=NEW'] }),
    ],
    ['raw pairs', (res: http.ServerResponse) => res.writeHead(200, ['Set-Cookie', 'metric_insights_session=NEW'])],
  ])("renames it in writeHead's headers given as %s", async (_form, write) => {
    let afterEnd: unknown;
    const res = await serve(NAMED, (_req, response) => {
      write(response);
      response.on('finish', () => {
        afterEnd = getMiSetCookie(response);
      });
      response.end();
    });

    expect(res.headers['set-cookie']).toEqual([`${NAMED}=NEW`]);
    expect(String(afterEnd)).toBe('metric_insights_session=NEW');
  });

  it("leaves the default instance's cookie as MI names it", async () => {
    let cookie: string | undefined;
    const res = await serve('metric_insights_session', (req, response) => {
      cookie = req.headers.cookie;
      response.setHeader('set-cookie', 'metric_insights_session=NEW');
      response.end();
    });

    expect(cookie).toBe('metric_insights_session=DEFAULT');
    expect(res.headers['set-cookie']).toEqual(['metric_insights_session=NEW']);
  });
});

describe('the Request Inspector', () => {
  it("redacts the browser's session cookies of other instances too", () => {
    expect(redactRequestHeaders({ cookie: `a=1; metric_insights_session=X; ${NAMED}=Y` }).cookie).toBe(
      `a=1; metric_insights_session=<redacted>; ${NAMED}=<redacted>`,
    );
  });

  it('redacts a renamed session cookie in a Set-Cookie', () => {
    expect(redactResponseHeaders({ 'set-cookie': [`${NAMED}=Y; Path=/`, 'other=1'] })['set-cookie']).toEqual([
      `${NAMED}=<redacted>; Path=/`,
      'other=1',
    ]);
  });
});
