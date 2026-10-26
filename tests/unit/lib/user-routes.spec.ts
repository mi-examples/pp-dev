import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInternalServer } from '../../../src/lib/internal.middleware.js';
import { registerUserRoutes, USERS_API_PATH } from '../../../src/lib/user-routes.js';
import { UserRegistry } from '../../../src/lib/user-registry.js';
import type { MiAPI } from '../../../src/lib/pp.middleware.js';

/** PP-4595: adding a saved user by API token through the internal API. */

function call(port: number, method: string, path: string, body?: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          host: 'localhost:3000',
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();

          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
        });
      },
    );

    req.on('error', reject);
    req.end(payload);
  });
}

describe('user routes', () => {
  let server: http.Server;
  let port: number;
  const users = new UserRegistry();
  const authInfo = vi.fn();
  const miAPI = {
    personalAccessToken: 'original-token' as string | undefined,
    get: (path: string, headers: Record<string, string>) => authInfo(path, headers),
  };

  beforeAll(async () => {
    const app = createInternalServer();

    registerUserRoutes(app, { miAPI: miAPI as unknown as MiAPI, users });

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    users.clear();
    authInfo.mockReset();
    authInfo.mockResolvedValue({ data: { user: { user_id: 42, username: 'viewer@example.com' } } });
    miAPI.personalAccessToken = 'original-token';
  });

  it('adds a user after MI accepts its token, and never sends the token back', async () => {
    const added = await call(port, 'POST', USERS_API_PATH, { name: 'viewer', token: ' viewer-token ' });

    expect(added.status).toBe(201);
    expect(added.body.user).toEqual({
      name: 'viewer',
      kind: 'token',
      miUser: { id: 42, username: 'viewer@example.com' },
      origin: 'http://viewer.localhost:3000',
    });
    expect(JSON.stringify(added.body)).not.toContain('viewer-token');

    expect(authInfo).toHaveBeenCalledWith(
      '/data/page/index/auth/info',
      expect.objectContaining({ Authorization: 'Bearer viewer-token' }),
    );
    expect(users.get('viewer')?.token).toBe('viewer-token');

    const listed = await call(port, 'GET', USERS_API_PATH);

    expect(listed.body).toEqual({ available: true, users: [added.body.user], defaultUser: null });
    expect(JSON.stringify(listed.body)).not.toContain('viewer-token');
  });

  it('needs the original user to have a token', async () => {
    miAPI.personalAccessToken = undefined;

    const res = await call(port, 'POST', USERS_API_PATH, { name: 'viewer', token: 'viewer-token' });

    expect(res).toMatchObject({ status: 409, body: { code: 'ORIGINAL_TOKEN_REQUIRED' } });
    expect(authInfo).not.toHaveBeenCalled();
  });

  it.each([
    [{ token: 'viewer-token' }, 'INVALID_NAME'],
    [{ name: 'Viewer One', token: 'viewer-token' }, 'INVALID_NAME'],
    [{ name: 'viewer' }, 'TOKEN_REQUIRED'],
    [{ name: 'viewer', token: '   ' }, 'TOKEN_REQUIRED'],
  ])('rejects %j with %s', async (body, code) => {
    const res = await call(port, 'POST', USERS_API_PATH, body);

    expect(res).toMatchObject({ status: 400, body: { code } });
    expect(authInfo).not.toHaveBeenCalled();
    expect(users.list()).toEqual([]);
  });

  it('rejects a taken name before asking MI', async () => {
    users.add({ name: 'viewer', kind: 'token', token: 'old-token' });

    const res = await call(port, 'POST', USERS_API_PATH, { name: 'viewer', token: 'viewer-token' });

    expect(res).toMatchObject({ status: 409, body: { code: 'NAME_TAKEN' } });
    expect(authInfo).not.toHaveBeenCalled();
    expect(users.get('viewer')?.token).toBe('old-token');
  });

  it('does not add a user when the project or MI instance changed while its token was checked', async () => {
    users.useContext('/work/app\nhttps://mi-a.example.com');

    let release!: () => void;

    authInfo.mockImplementationOnce(
      () =>
        new Promise((resolve) => (release = () => resolve({ data: { user: { user_id: 42, username: 'viewer' } } }))),
    );

    const adding = call(port, 'POST', USERS_API_PATH, { name: 'viewer', token: 'viewer-token' });

    await vi.waitFor(() => expect(release).toBeDefined());
    users.useContext('/work/app\nhttps://mi-b.example.com');
    release();

    expect(await adding).toMatchObject({ status: 409, body: { code: 'CONTEXT_CHANGED' } });
    expect(users.list()).toEqual([]);
  });

  it('rejects a token MI turns down', async () => {
    authInfo.mockRejectedValue(Object.assign(new Error('Unauthorized'), { response: { status: 401, data: {} } }));

    const res = await call(port, 'POST', USERS_API_PATH, { name: 'viewer', token: 'bad-token' });

    expect(res).toMatchObject({ status: 400, body: { code: 'INVALID_TOKEN' } });
    expect(users.list()).toEqual([]);
  });

  it('rejects a token MI answers without a user', async () => {
    authInfo.mockResolvedValue({ data: {} });

    const res = await call(port, 'POST', USERS_API_PATH, { name: 'viewer', token: 'viewer-token' });

    expect(res).toMatchObject({ status: 400, body: { code: 'INVALID_TOKEN' } });
  });

  it('reports MI being unreachable apart from a bad token', async () => {
    authInfo.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const res = await call(port, 'POST', USERS_API_PATH, { name: 'viewer', token: 'viewer-token' });

    expect(res).toMatchObject({ status: 502, body: { code: 'MI_UNAVAILABLE' } });
  });

  it('adds a session user that logs in on its own host, without asking MI', async () => {
    const added = await call(port, 'POST', USERS_API_PATH, { name: 'qa', kind: 'session' });

    expect(added.status).toBe(201);
    expect(added.body.user).toEqual({
      name: 'qa',
      kind: 'session',
      state: 'pending',
      origin: 'http://qa.localhost:3000',
      loginUrl: 'http://qa.localhost:3000/login',
    });
    expect(authInfo).not.toHaveBeenCalled();
    expect(users.get('qa')?.state).toBe('pending');
  });

  it('never sends a session user its MI session back', async () => {
    Object.assign(users.add({ name: 'qa', kind: 'session' }), { state: 'active', session: 'SECRET-SESSION' });

    const listed = await call(port, 'GET', USERS_API_PATH);

    expect(listed.body.users[0]).toMatchObject({ name: 'qa', state: 'active' });
    expect(JSON.stringify(listed.body)).not.toContain('SECRET-SESSION');
  });

  it('rejects an unknown kind', async () => {
    const res = await call(port, 'POST', USERS_API_PATH, { name: 'qa', kind: 'password' });

    expect(res).toMatchObject({ status: 400, body: { code: 'INVALID_KIND' } });
  });

  it('needs the original token for a session user too', async () => {
    miAPI.personalAccessToken = undefined;

    const res = await call(port, 'POST', USERS_API_PATH, { name: 'qa', kind: 'session' });

    expect(res).toMatchObject({ status: 409, body: { code: 'ORIGINAL_TOKEN_REQUIRED' } });
  });

  it('says users are unavailable without the original token', async () => {
    miAPI.personalAccessToken = undefined;

    expect((await call(port, 'GET', USERS_API_PATH)).body.available).toBe(false);
  });

  describe('default user (PP-4597)', () => {
    it('makes a user the default, and the original user again', async () => {
      users.add({ name: 'viewer', kind: 'token', token: 'viewer-token' });

      expect(await call(port, 'PUT', `${USERS_API_PATH}/default`, { name: 'viewer' })).toMatchObject({
        status: 200,
        body: { defaultUser: 'viewer' },
      });
      expect(users.defaultUser?.name).toBe('viewer');
      expect((await call(port, 'GET', USERS_API_PATH)).body.defaultUser).toBe('viewer');

      await call(port, 'PUT', `${USERS_API_PATH}/default`, { name: null });

      expect(users.defaultUser).toBeUndefined();
    });

    it('refuses an unknown user, a session user that has not logged in, and a bad name', async () => {
      users.add({ name: 'qa', kind: 'session' });

      expect(await call(port, 'PUT', `${USERS_API_PATH}/default`, { name: 'ghost' })).toMatchObject({
        status: 404,
        body: { code: 'NOT_FOUND' },
      });
      expect(await call(port, 'PUT', `${USERS_API_PATH}/default`, { name: 'qa' })).toMatchObject({
        status: 409,
        body: { code: 'NOT_LOGGED_IN' },
      });
      expect(await call(port, 'PUT', `${USERS_API_PATH}/default`, { name: 42 })).toMatchObject({
        status: 400,
        body: { code: 'INVALID_NAME' },
      });
      expect(users.defaultUser).toBeUndefined();
    });
  });

  describe('editing a token user', () => {
    beforeEach(() => {
      users.add({
        name: 'viewer',
        kind: 'token',
        token: 'viewer-token',
        miUser: { id: 42, username: 'viewer@example.com' },
      });
    });

    it('renames it, keeping its token, without asking MI', async () => {
      const edited = await call(port, 'PATCH', `${USERS_API_PATH}/viewer`, { name: 'reader' });

      expect(edited.status).toBe(200);
      expect(edited.body.user).toMatchObject({ name: 'reader', origin: 'http://reader.localhost:3000' });
      expect(JSON.stringify(edited.body)).not.toContain('viewer-token');
      expect(authInfo).not.toHaveBeenCalled();
      expect(users.get('reader')).toMatchObject({ token: 'viewer-token' });
      expect(users.renamedTo('viewer')).toBe('reader');
    });

    it('replaces its token once MI accepts the new one', async () => {
      authInfo.mockResolvedValue({ data: { user: { user_id: 7, username: 'qa@example.com' } } });

      const edited = await call(port, 'PATCH', `${USERS_API_PATH}/viewer`, { name: 'viewer', token: ' new-token ' });

      expect(edited.status).toBe(200);
      expect(authInfo).toHaveBeenCalledWith(
        '/data/page/index/auth/info',
        expect.objectContaining({ Authorization: 'Bearer new-token' }),
      );
      expect(users.get('viewer')).toMatchObject({ token: 'new-token', miUser: { id: 7 } });
    });

    it('keeps the old token and user when MI turns the new one down', async () => {
      const viewer = users.get('viewer');

      authInfo.mockRejectedValue(Object.assign(new Error('Unauthorized'), { response: { status: 401, data: {} } }));

      const edited = await call(port, 'PATCH', `${USERS_API_PATH}/viewer`, { name: 'reader', token: 'bad-token' });

      expect(edited).toMatchObject({ status: 400, body: { code: 'INVALID_TOKEN' } });
      expect(users.get('viewer')).toBe(viewer);
      expect(users.get('reader')).toBeUndefined();
    });

    it('refuses a bad or taken name', async () => {
      users.add({ name: 'qa', kind: 'session' });

      expect(await call(port, 'PATCH', `${USERS_API_PATH}/viewer`, { name: 'qa' })).toMatchObject({
        status: 409,
        body: { code: 'NAME_TAKEN' },
      });
      expect(await call(port, 'PATCH', `${USERS_API_PATH}/viewer`, { name: 'qa_power' })).toMatchObject({
        status: 400,
        body: { code: 'INVALID_NAME' },
      });
    });

    it('does not edit a session user or an unknown one', async () => {
      users.add({ name: 'qa', kind: 'session' });

      expect(await call(port, 'PATCH', `${USERS_API_PATH}/qa`, { name: 'qa2' })).toMatchObject({
        status: 400,
        body: { code: 'NOT_EDITABLE' },
      });
      expect(await call(port, 'PATCH', `${USERS_API_PATH}/ghost`, { name: 'ghost2' })).toMatchObject({
        status: 404,
        body: { code: 'NOT_FOUND' },
      });
    });
  });

  it('removes a user', async () => {
    users.add({ name: 'viewer', kind: 'token', token: 'viewer-token' });

    expect((await call(port, 'DELETE', `${USERS_API_PATH}/viewer`)).status).toBe(204);
    expect(users.list()).toEqual([]);
    expect(await call(port, 'DELETE', `${USERS_API_PATH}/viewer`)).toMatchObject({
      status: 404,
      body: { code: 'NOT_FOUND' },
    });
  });
});
