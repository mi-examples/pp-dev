import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MiAPI } from '../../../src/lib/pp.middleware.js';
import { originalSession } from '../../../src/lib/original-session.js';
import { onProxyCacheInvalidate } from '../../../src/lib/proxy-cache.middleware.js';
import type { MiUser } from '../../../src/lib/mi-identity.js';

/**
 * PP-4602: without an API token, the dev panel's own MI calls go with the MI session of your login on
 * localhost, from any host: a saved user's host passes no credentials of its own on (see
 * load-pp-data), so they went to MI as nobody.
 */

const DEV: MiUser = { id: 7, username: 'dev' };

function headersOf(call: unknown[] | undefined): Record<string, unknown> {
  return (call?.at(-1) ?? {}) as Record<string, unknown>;
}

/** Logs `session` in on localhost, as the proxy would on a main-host response. */
async function logInOnLocalhost(session: string, check = async (s: string) => (s === session ? DEV : undefined)) {
  originalSession.useCheck(check);
  await originalSession.observe(
    { method: 'GET', url: '/home', headers: { cookie: `metric_insights_session=${session}` } },
    { statusCode: 200, headers: {} },
  );
}

function makeMi(baseURL = 'http://mi.example.com', personalAccessToken?: string) {
  return new MiAPI(baseURL, {
    templateLess: true,
    appId: 7,
    personalAccessToken,
    headers: { host: 'mi.example.com', referer: baseURL, origin: baseURL },
  });
}

/** A page data load from a saved user's host: no credentials (see getPageDataHeaders). */
async function loadFromUserHost(mi: MiAPI) {
  vi.spyOn(mi['pageApi'], 'get').mockResolvedValue({ name: 'Sales', template: 'tpl', tags: '[]' } as never);
  vi.spyOn(mi, 'getPageTemplate').mockResolvedValue('<html></html>' as never);
  await mi.getPageVariables(7, { host: 'qa.localhost:3000', accept: 'text/html' });
}

describe('MiAPI — the dev panel as your login on localhost', () => {
  // The session is the process's own, which other specs in this worker may have touched.
  beforeEach(() => {
    originalSession.clear();
  });

  afterEach(() => {
    originalSession.clear();
    vi.restoreAllMocks();
  });

  it('sends the sync with your MI session, though the page loaded on a saved user host', async () => {
    await logInOnLocalhost('MAIN');

    const mi = makeMi();

    await loadFromUserHost(mi);

    const download = vi.spyOn(mi['assetsApi'], 'downloadPageAssets').mockResolvedValue(Buffer.alloc(0) as never);

    await mi.getAssets();

    expect(headersOf(download.mock.calls[0])).toMatchObject({ cookie: 'metric_insights_session=MAIN' });
  });

  it('puts your session in place of the one the main host sent, keeping its other cookies', async () => {
    await logInOnLocalhost('MAIN');

    const mi = makeMi();
    const getAll = vi.spyOn(mi['pageApi'], 'getAll').mockResolvedValue([] as never);

    await mi.listPages({ cookie: 'theme=dark; metric_insights_session=OLD' });

    expect(headersOf(getAll.mock.calls[0])).toMatchObject({ cookie: 'theme=dark; metric_insights_session=MAIN' });
  });

  it('sends no session once it ended, and does not keep it in the stored headers', async () => {
    await logInOnLocalhost('MAIN');

    const mi = makeMi();

    await loadFromUserHost(mi);
    originalSession.loggedOut();

    const download = vi.spyOn(mi['assetsApi'], 'downloadPageAssets').mockResolvedValue(Buffer.alloc(0) as never);

    await mi.getAssets();

    expect(headersOf(download.mock.calls[0])).not.toHaveProperty('cookie');
  });

  // Review of #401: a page load on localhost stored its MI session in the headers, which the sync
  // went on sending once the login ended, as if it still were yours.
  describe('headers stored from a page load on localhost, once the login ended', () => {
    /** A page data load from a host whose cookies carry `cookie`. */
    async function loadWithCookie(mi: MiAPI, cookie: string) {
      vi.spyOn(mi['pageApi'], 'get').mockResolvedValue({ name: 'Sales', template: 'tpl', tags: '[]' } as never);
      vi.spyOn(mi, 'getPageTemplate').mockResolvedValue('<html></html>' as never);
      await mi.getPageVariables(7, { host: 'localhost:3000', cookie });
    }

    it("drops the login's session, keeping the other cookies", async () => {
      await logInOnLocalhost('MAIN');

      const mi = makeMi();

      await loadWithCookie(mi, 'theme=dark; metric_insights_session=MAIN');
      originalSession.loggedOut();

      const download = vi.spyOn(mi['assetsApi'], 'downloadPageAssets').mockResolvedValue(Buffer.alloc(0) as never);

      await mi.getAssets();

      expect(headersOf(download.mock.calls[0])).toMatchObject({ cookie: 'theme=dark' });
    });

    it("keeps a session that isn't the login's (an IP address's own)", async () => {
      await logInOnLocalhost('MAIN');

      const mi = makeMi();

      await loadWithCookie(mi, 'metric_insights_session=IP-HOST');
      originalSession.loggedOut();

      const download = vi.spyOn(mi['assetsApi'], 'downloadPageAssets').mockResolvedValue(Buffer.alloc(0) as never);

      await mi.getAssets();

      expect(headersOf(download.mock.calls[0])).toMatchObject({ cookie: 'metric_insights_session=IP-HOST' });
    });
  });

  // Review of #401: dropped through the proxy cache's listeners, page data included, though no new
  // session reached the browser.
  it('drops what is cached when the login ends', async () => {
    const dropped = vi.fn();
    const unsubscribe = onProxyCacheInvalidate(dropped);

    try {
      await logInOnLocalhost('MAIN');
      dropped.mockClear();

      originalSession.loggedOut();

      expect(dropped).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('goes by the API token when there is one', async () => {
    await logInOnLocalhost('MAIN');

    const mi = makeMi('http://mi.example.com', 'DEV-PAT');
    const download = vi.spyOn(mi['assetsApi'], 'downloadPageAssets').mockResolvedValue(Buffer.alloc(0) as never);

    await mi.getAssets();

    const headers = headersOf(download.mock.calls[0]);

    expect(headers).toMatchObject({ authorization: 'Bearer DEV-PAT' });
    expect(headers).not.toHaveProperty('cookie');
  });

  it('adds nothing before anyone logged in on localhost', async () => {
    const mi = makeMi();
    const download = vi.spyOn(mi['assetsApi'], 'downloadPageAssets').mockResolvedValue(Buffer.alloc(0) as never);

    await mi.getAssets();

    expect(headersOf(download.mock.calls[0])).not.toHaveProperty('cookie');
  });

  describe('a call MI refuses', () => {
    let server: http.Server;
    let baseURL: string;
    let received: (string | undefined)[];

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        received.push(req.headers.cookie);
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end('{}');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    beforeEach(() => {
      received = [];
    });

    it('has MI asked whether your session ended, and ends it when it did', async () => {
      const check = vi.fn(async (s: string) => (s === 'MAIN' ? DEV : undefined));

      await logInOnLocalhost('MAIN', check);
      // MI ended it meanwhile.
      check.mockResolvedValue(undefined);

      await expect(makeMi(baseURL).listPages()).rejects.toThrow();

      expect(received).toEqual(['metric_insights_session=MAIN']);
      await vi.waitFor(() => expect(originalSession.state).toBe('expired'));
      expect(check).toHaveBeenLastCalledWith('MAIN');
    });

    it('keeps your session when MI still knows its user', async () => {
      await logInOnLocalhost('MAIN');

      await expect(makeMi(baseURL).listPages()).rejects.toThrow();
      // The recheck runs after the refusal; give it its turn.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(originalSession.session).toBe('MAIN');
    });
  });
});
