import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INSPECTOR_PATH, registerInspectorRoutes } from '../../../src/lib/request-inspector.js';
import { RequestStore } from '../../../src/lib/request-store.js';

function makeApp() {
  const handlers = new Map<string, (req: any, res: any) => any>();

  const app = {
    handlers,
    get(path: string, handler: (req: any, res: any) => any) {
      handlers.set(`GET ${path}`, handler);
    },
    delete(path: string, handler: (req: any, res: any) => any) {
      handlers.set(`DELETE ${path}`, handler);
    },
  };

  return app as unknown as import('express').Application & { handlers: typeof handlers };
}

describe('registerInspectorRoutes', () => {
  it('registers routes and keeps stores isolated for every app instance', () => {
    const firstApp = makeApp();
    const secondApp = makeApp();
    const firstRes: any = { json: (body: unknown) => (firstRes.body = body) };
    const secondRes: any = { json: (body: unknown) => (secondRes.body = body) };

    registerInspectorRoutes(firstApp, new RequestStore(1_000));
    registerInspectorRoutes(secondApp, new RequestStore(2_000));

    firstApp.handlers.get('GET /@api/requests/stats')!({}, firstRes);
    secondApp.handlers.get('GET /@api/requests/stats')!({}, secondRes);

    expect(firstRes.body.maxMemory).toBe(1_000);
    expect(secondRes.body.maxMemory).toBe(2_000);
  });

  it('updates the store when the same app is registered again', () => {
    const app = makeApp();
    const res: any = { json: (body: unknown) => (res.body = body) };

    registerInspectorRoutes(app, new RequestStore(1_000));
    registerInspectorRoutes(app, new RequestStore(2_000));
    app.handlers.get('GET /@api/requests/stats')!({}, res);

    expect(res.body.maxMemory).toBe(2_000);
  });
});

describe('GET /@api/requests', () => {
  it('takes the first value of a repeated query parameter instead of failing', () => {
    const app = makeApp();
    const store = new RequestStore();
    const res: any = { json: (body: unknown) => (res.body = body) };

    for (const [method, url] of [
      ['GET', '/a'],
      ['POST', '/b'],
    ]) {
      store.add({
        id: store.allocateId(),
        timestamp: 0,
        method,
        url,
        statusCode: 200,
        duration: 0,
        source: 'proxy',
        requestHeaders: {},
        requestBody: null,
        requestBodyTruncated: false,
        responseHeaders: {},
        responseBody: null,
        responseBodyTruncated: false,
      });
    }

    registerInspectorRoutes(app, store);
    app.handlers.get('GET /@api/requests')!({ query: { method: ['post', 'get'], search: ['/b', '/a'] } }, res);

    expect(res.body.requests.map((e: { url: string }) => e.url)).toEqual(['/b']);
  });
});

// The page was a template literal built on every request; it is now built from
// src/client/request-inspector into dist/client, and served from there.
describe('the Request Inspector page', () => {
  let clientDir: string;

  beforeEach(() => {
    clientDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-inspector-client-'));
    fs.copyFileSync(
      path.resolve(__dirname, '../../../src/client/request-inspector/request-inspector.html'),
      path.join(clientDir, 'request-inspector.html'),
    );
    fs.writeFileSync(path.join(clientDir, 'request-inspector.js'), 'console.log("inspector");');
    fs.writeFileSync(path.join(clientDir, 'secret.txt'), 'not for the browser');
  });

  afterEach(() => {
    fs.rmSync(clientDir, { recursive: true, force: true });
  });

  function request(app: ReturnType<typeof makeApp>, route: string, params: Record<string, string> = {}) {
    return new Promise<{ status: number; headers: Record<string, string>; body: string; passed: boolean }>(
      (resolve) => {
        const res: any = {
          statusCode: 200,
          headers: {} as Record<string, string>,
          setHeader(name: string, value: string) {
            res.headers[name.toLowerCase()] = value;
          },
          status(code: number) {
            res.statusCode = code;

            return res;
          },
          type(value: string) {
            res.headers['content-type'] = value;

            return res;
          },
          end(body: string | Buffer) {
            resolve({ status: res.statusCode, headers: res.headers, body: String(body), passed: false });
          },
        };

        app.handlers.get(`GET ${route}`)!({ params }, res, () =>
          resolve({ status: 0, headers: {}, body: '', passed: true }),
        );
      },
    );
  }

  it('serves the built page with the capture limit filled in', async () => {
    const app = makeApp();

    registerInspectorRoutes(app, new RequestStore(), 5 * 1024 * 1024, clientDir);

    const page = await request(app, INSPECTOR_PATH);

    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.body).toContain('data-capture-limit="5242880"');
    expect(page.body).toContain('<script type="module" src="/@pp-dev/inspector/request-inspector.js">');
    // No inline handlers left: the page script handles every click.
    expect(page.body).not.toMatch(/\son[a-z]+=/);
  });

  it('says so when the page is not built', async () => {
    const app = makeApp();

    fs.rmSync(path.join(clientDir, 'request-inspector.html'));
    registerInspectorRoutes(app, new RequestStore(), undefined, clientDir);

    const page = await request(app, INSPECTOR_PATH);

    expect(page.status).toBe(500);
    expect(page.body).toContain('request-inspector page not built');
  });

  it("serves the page's own script and styles, and nothing else from the folder", async () => {
    const app = makeApp();

    registerInspectorRoutes(app, new RequestStore(), undefined, clientDir);

    const script = await request(app, `${INSPECTOR_PATH}/:file`, { file: 'request-inspector.js' });

    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(script.body).toBe('console.log("inspector");');

    for (const file of ['secret.txt', '../package.json', 'request-inspector.html']) {
      expect((await request(app, `${INSPECTOR_PATH}/:file`, { file })).passed, file).toBe(true);
    }

    // Listed, but not built: left to the next handler too.
    expect((await request(app, `${INSPECTOR_PATH}/:file`, { file: 'request-inspector.css' })).passed).toBe(true);
  });
});
