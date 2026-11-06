import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInternalServer, INTERNAL_JSON_BODY_LIMIT } from '../../../src/lib/internal.middleware.js';

/**
 * The internal API (variables editor, users, login) parses JSON bodies with Express. With the
 * default 100 kb limit a large `__template_variables.json` failed to save, and the failure came
 * back as Express' HTML error page, which the editor could not show: the save was lost silently.
 */

let server: http.Server;
let port: number;

beforeAll(async () => {
  const app = createInternalServer();

  app.put('/@api/echo', (req, res) => {
    res.json({ size: JSON.stringify(req.body).length });
  });

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function put(body: string) {
  return new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/@api/echo',
        method: 'PUT',
        agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );

    // The server may answer 413 and close before the whole body is sent.
    req.on('error', reject);
    req.end(body);
  });
}

describe('createInternalServer', () => {
  it('accepts a JSON body over Express’ default 100 kb', async () => {
    const raw = JSON.stringify({ tags: Array.from({ length: 5000 }, (_, i) => ({ name: `variable_${i}` })) });
    const body = JSON.stringify({ raw });

    expect(Buffer.byteLength(body)).toBeGreaterThan(100 * 1024);

    const res = await put(body);

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ size: body.length });
  });

  it('answers a body over the limit with a JSON error', async () => {
    const body = JSON.stringify({ raw: 'x'.repeat(11 * 1024 * 1024) });

    const res = await put(body);

    expect(res.status).toBe(413);
    expect(res.type).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({
      error: `The request body is larger than the dev server accepts (${INTERNAL_JSON_BODY_LIMIT}).`,
    });
  });

  it('answers malformed JSON with a JSON error', async () => {
    const res = await put('{"raw": ');

    expect(res.status).toBe(400);
    expect(res.type).toContain('application/json');
    expect(JSON.parse(res.body).error).toMatch(/^The request body could not be read: /);
  });
});
