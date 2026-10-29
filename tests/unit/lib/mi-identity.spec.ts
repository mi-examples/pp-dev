import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkUserToken, createSessionCheck, whoIs } from '../../../src/lib/mi-identity.js';
import { MiAPI } from '../../../src/lib/pp.middleware.js';
import { createLogger } from '../../../src/lib/logger.js';

/**
 * One check of whose token or session MI sees, for the users' routes, the session tracker and the
 * token store. It was written twice (user-routes, session-users), and the store imported it from
 * the HTTP routes. A token MI refused also logged "API request failed" and four tips to refresh a
 * token, as if the developer's own token had failed.
 */

const httpError = (status: number) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });

function fakeMi(get: (...args: unknown[]) => Promise<unknown>) {
  return { get: vi.fn(get) } as unknown as MiAPI;
}

describe('whoIs', () => {
  it('answers with the MI user', async () => {
    const mi = fakeMi(async () => ({ data: { user: { user_id: 7, username: 'qa' } } }));

    expect(await whoIs(mi, { Authorization: 'Bearer t' })).toEqual({ miUser: { id: 7, username: 'qa' } });
    expect(mi.get).toHaveBeenCalledWith(
      '/data/page/index/auth/info',
      expect.objectContaining({ Authorization: 'Bearer t', Accept: 'application/json' }),
      true,
      { quiet: true },
    );
  });

  it('answers with no user for a guest, and says why MI refused credentials', async () => {
    expect(
      await whoIs(
        fakeMi(async () => ({ data: {} })),
        {},
      ),
    ).toEqual({ miUser: undefined });
    expect(
      await whoIs(
        fakeMi(() => Promise.reject(httpError(401))),
        {},
      ),
    ).toEqual({
      miUser: undefined,
      refused: 'Unauthorized access',
    });
  });

  it('throws when MI cannot tell', async () => {
    await expect(
      whoIs(
        fakeMi(() => Promise.reject(httpError(503))),
        {},
      ),
    ).rejects.toThrow('503');
  });
});

describe('checkUserToken and createSessionCheck share it', () => {
  it('reports a token the same ways as before', async () => {
    expect(
      await checkUserToken(
        fakeMi(async () => ({ data: { user: { user_id: 1, username: 'a' } } })),
        't',
      ),
    ).toEqual({
      ok: true,
      miUser: { id: 1, username: 'a' },
    });
    expect(
      await checkUserToken(
        fakeMi(async () => ({ data: {} })),
        't',
      ),
    ).toEqual({
      ok: false,
      rejected: true,
      message: 'The API token is expired or invalid',
    });
    expect(
      await checkUserToken(
        fakeMi(() => Promise.reject(httpError(403))),
        't',
      ),
    ).toEqual({
      ok: false,
      rejected: true,
      message: 'The API token was rejected: Access forbidden',
    });
    expect(
      await checkUserToken(
        fakeMi(() => Promise.reject(httpError(500))),
        't',
      ),
    ).toMatchObject({
      ok: false,
      rejected: false,
    });
  });

  it('checks a session by its cookie', async () => {
    const mi = fakeMi(async () => ({ data: { user: { user_id: 2, username: 'b' } } }));

    expect(await createSessionCheck(mi)('S1')).toEqual({ id: 2, username: 'b' });
    expect(mi.get).toHaveBeenCalledWith(
      '/data/page/index/auth/info',
      expect.objectContaining({ Cookie: 'metric_insights_session=S1' }),
      true,
      { quiet: true },
    );
  });
});

describe('a token MI refuses', () => {
  let server: http.Server;
  let baseURL: string;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Unauthorized' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is not logged as a failed request of the developer', async () => {
    const error = vi.spyOn(createLogger(), 'error');
    const info = vi.spyOn(createLogger(), 'info');

    expect(await checkUserToken(new MiAPI(baseURL), 'someone-elses-token')).toMatchObject({
      ok: false,
      rejected: true,
    });
    expect(error).not.toHaveBeenCalled();
    expect(info.mock.calls.some(([message]) => String(message).includes('Suggestions'))).toBe(false);
  });

  it('still is for any other request', async () => {
    const error = vi.spyOn(createLogger(), 'error');

    await expect(new MiAPI(baseURL).get('/api/user', {}, true)).rejects.toThrow('401');
    expect(error.mock.calls.some(([message]) => String(message).includes('API request failed'))).toBe(true);
  });
});
