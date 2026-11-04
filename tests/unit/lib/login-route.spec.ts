import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInternalServer } from '../../../src/lib/internal.middleware.js';
import { LOGIN_API_PATH, registerLoginRoute } from '../../../src/lib/login-route.js';
import type { MiAPI } from '../../../src/lib/pp.middleware.js';

/**
 * The token login behind the form pp-dev adds to MI's `/login` page. It lived in the Vite plugin
 * only, so under `pp-dev next` the form's request had no route and hung; and a request without a
 * JSON body crashed it (Express 5 leaves `req.body` undefined).
 */

const get = vi.fn();
const miAPI = { get, personalAccessToken: undefined } as unknown as MiAPI & { personalAccessToken?: string };

let server: http.Server;
let port: number;

beforeAll(async () => {
  const app = createInternalServer();

  registerLoginRoute(app, { miAPI, persistUsers: false, projectRoot: process.cwd(), miUrl: 'https://mi.example.com' });

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  get.mockReset();
  miAPI.personalAccessToken = undefined;
});

function post(body: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: LOGIN_API_PATH,
        method: 'POST',
        agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );

    req.on('error', reject);
    req.end(body);
  });
}

describe('registerLoginRoute', () => {
  it('answers a request without a readable body with 400, not a crash', async () => {
    const response = await post('token=abc', { 'Content-Type': 'text/plain' });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'Token is required' });
  });

  it('takes a valid personal access token as the dev server’s own and sends the browser to the page', async () => {
    get.mockResolvedValue({ data: { user: { user_id: 7, username: 'dev' } }, headers: {} });

    const response = await post(JSON.stringify({ token: 'pat-1', tokenType: 'personal' }));

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/');
    expect(miAPI.personalAccessToken).toBe('pat-1');
    expect(get).toHaveBeenCalledWith(
      '/data/page/index/auth/info',
      expect.objectContaining({ Authorization: 'Bearer pat-1' }),
      true,
    );
  });

  it('refuses a personal access token MI does not know', async () => {
    get.mockResolvedValue({ data: {}, headers: {} });

    const response = await post(JSON.stringify({ token: 'pat-2', tokenType: 'personal' }));

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'Token expired or invalid' });
    expect(miAPI.personalAccessToken).toBeUndefined();
  });

  it('refuses an unknown token type', async () => {
    const response = await post(JSON.stringify({ token: 'x', tokenType: 'other' }));

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'INVALID_TOKEN_TYPE' });
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses to change the original user's token from a saved user's host", async () => {
    const response = await post(JSON.stringify({ token: 'pat-3', tokenType: 'personal' }), {
      Host: 'alice.localhost:3000',
    });

    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'USER_HOST' });
    expect(get).not.toHaveBeenCalled();
  });
});
