import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMiddlewareChain, type MiddlewareChain } from '../../../src/lib/middleware-chain.js';
import { createInternalServer } from '../../../src/lib/internal.middleware.js';
import { runMiddlewareChain } from '../../../src/lib/dev-server-setup.js';
import { invalidateProxyCache } from '../../../src/lib/proxy-cache.middleware.js';
import { clearAPICache } from '../../../src/lib/load-pp-data.middleware.js';

/**
 * The request pipeline `pp-dev` and `pp-dev next` share. Each used to build its own, and the two
 * had drifted (where pp-dev's own routes were mounted, what the page-data load was told, the
 * error handling). Run here as `pp-dev next` runs it, on a raw http server, against an MI stand-in.
 */

const BASE = '/pl/chain-app/';

function listen(server: http.Server) {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

type Served = { status: number; headers: http.IncomingHttpHeaders; body: string };

function get(port: number, path: string, headers: http.OutgoingHttpHeaders = {}) {
  return new Promise<Served>((resolve, reject) => {
    http
      .request({ host: '127.0.0.1', port, path, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        );
      })
      .on('error', reject)
      .end();
  });
}

/** The renderer behind the chain: the page at index.html, nothing else. */
function render(req: http.IncomingMessage, res: http.ServerResponse) {
  if ((req.url ?? '').split('?')[0].endsWith('index.html')) {
    res.setHeader('content-type', 'text/html');
    res.end('<html><body><p>[Name]</p></body></html>');

    return;
  }

  res.statusCode = 404;
  res.end('renderer: not found');
}

function serveChain(chain: MiddlewareChain, which: 'main' | 'essential' = 'main') {
  const middlewares = which === 'main' && chain.rewrite ? [...chain.main, chain.rewrite] : chain[which];

  return http.createServer((req, res) => runMiddlewareChain(middlewares, req, res, () => render(req, res)));
}

describe('the middleware chain', () => {
  let upstream: http.Server;
  let upstreamHits: string[];
  let upstreamUrl: string;

  beforeAll(async () => {
    upstreamHits = [];
    upstream = http.createServer((req, res) => {
      upstreamHits.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ from: 'mi', url: req.url }));
    });
    upstreamUrl = `http://127.0.0.1:${await listen(upstream)}`;
  });

  afterAll(async () => {
    await close(upstream);
  });

  beforeEach(() => {
    upstreamHits = [];
    invalidateProxyCache('test');
    clearAPICache();
  });

  function build(backend: boolean, inspector = true, base = BASE) {
    return createMiddlewareChain({
      base,
      templateName: 'chain-app',
      internalServer: createInternalServer(),
      backendBaseURL: backend ? upstreamUrl : undefined,
      mi: { appId: 1, templateLess: true, miHudLess: true, disableSSLValidation: false, v7Features: true },
      inspector: { enabled: inspector, maxMemory: 1024 * 1024, captureLimit: 64 * 1024 },
      proxy: { cache: true, cacheTtl: 60_000 },
      rewrite: (mi, baseUrlHost) => ({
        predicate: (url) => url.split('?')[0].endsWith('index.html'),
        transform: (response) =>
          Buffer.from(response.toString('utf8').replace('[Name]', `${mi.constructor.name}@${baseUrlHost}`)),
      }),
    });
  }

  describe('with a backend', () => {
    let chain: MiddlewareChain;
    let server: http.Server;
    let port: number;

    beforeAll(async () => {
      chain = build(true);
      server = serveChain(chain);
      port = await listen(server);
    });

    afterAll(async () => {
      await close(server);
    });

    it('has the MI client, the cache TTL and the rewrite', () => {
      expect(chain.mi).not.toBeNull();
      expect(chain.proxyCacheTtl).toBe(60_000);
      expect(chain.rewrite).not.toBeNull();
      expect(chain.essential.length).toBeLessThan(chain.main.length);
    });

    it('redirects the root to the page', async () => {
      const res = await get(port, '/');

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(BASE);
    });

    it('proxies to MI, through the cache, marked as proxied', async () => {
      const first = await get(port, '/data/page/1/items.json');
      const second = await get(port, '/data/page/1/items.json');

      expect(first.status).toBe(200);
      expect(JSON.parse(first.body)).toEqual({ from: 'mi', url: '/data/page/1/items.json' });
      expect(first.headers['x-pp-proxy']).toBe('1');
      expect(second.headers['x-pp-cache']).toBe('hit');
      expect(upstreamHits).toEqual(['GET /data/page/1/items.json']);
    });

    it("serves pp-dev's own routes from the internal server, and ends what none of them answers", async () => {
      const inspector = await get(port, '/@api/requests');
      const unknown = await get(port, '/@api/no-such-route');

      expect(inspector.status).toBe(200);
      expect(JSON.parse(inspector.body)).toMatchObject({ requests: expect.any(Array) });
      expect(unknown.status).toBe(404);
      expect(JSON.parse(unknown.body)).toEqual({ error: 'Not found' });
      expect(upstreamHits).toEqual([]);
    });

    it('rewrites the page the renderer gives, with the MI client and its host', async () => {
      const res = await get(port, `${BASE}index.html`);

      expect(res.status).toBe(200);
      expect(res.body).toContain(`<p>MiAPI@${new URL(upstreamUrl).host}</p>`);
    });

    it('turns a user host with no saved user away before anything else', async () => {
      const res = await get(port, '/data/page/1/items.json', { host: `nobody.localhost:${port}` });

      expect(res.status).toBe(404);
      expect(res.body).toContain('no user named "nobody"');
      expect(upstreamHits).toEqual([]);
    });

    it('captures what went through for the inspector', async () => {
      await get(port, '/data/page/1/captured.json');

      const listed = await get(port, '/@api/requests');
      const urls = (JSON.parse(listed.body) as { requests: { url: string }[] }).requests.map((r) => r.url);

      expect(urls).toContain('/data/page/1/captured.json');
    });

    it("leaves a bundler's own file alone on the essential chain: no proxy, no rewrite", async () => {
      const essential = serveChain(chain, 'essential');
      const essentialPort = await listen(essential);

      try {
        const file = await get(essentialPort, '/_next/static/chunk.js');
        const root = await get(essentialPort, '/');

        expect(file.status).toBe(404);
        expect(file.body).toBe('renderer: not found');
        expect(root.status).toBe(302);
        expect(upstreamHits).toEqual([]);
      } finally {
        await close(essential);
      }
    });
  });

  describe('without a backend', () => {
    let chain: MiddlewareChain;
    let server: http.Server;
    let port: number;

    beforeAll(async () => {
      chain = build(false);
      server = serveChain(chain);
      port = await listen(server);
    });

    afterAll(async () => {
      await close(server);
    });

    it('has no MI client, no cache and no rewrite', () => {
      expect(chain.mi).toBeNull();
      expect(chain.proxyCacheTtl).toBeNull();
      expect(chain.rewrite).toBeNull();
    });

    it('still serves the Request Inspector and the redirects', async () => {
      const inspector = await get(port, '/@api/requests');
      const root = await get(port, '/');
      const page = await get(port, `${BASE}index.html`);

      expect(inspector.status).toBe(200);
      expect(root.status).toBe(302);
      expect(page.body).toContain('<p>[Name]</p>');
    });

    it('answers a user host like any other, having no users', async () => {
      const res = await get(port, `${BASE}index.html`, { host: `nobody.localhost:${port}` });

      expect(res.status).toBe(200);
    });
  });

  // With a base of `/` every HTML navigation is one into the app: the inspector page reached the
  // page-data load first, and MI being down kept it from opening (review note). Its API route
  // stands in for the page here, which is served from the built `dist/client`.
  it("serves pp-dev's own routes before the page-data load, whatever the base", async () => {
    const chain = build(true, true, '/');
    const server = serveChain(chain);
    const port = await listen(server);

    try {
      const res = await get(port, '/@api/requests', { accept: 'text/html' });

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ requests: expect.any(Array) });
      expect(upstreamHits).toEqual([]);
    } finally {
      await close(server);
    }
  });

  it('mounts nothing of its own when there is neither a backend nor the inspector', () => {
    const chain = build(false, false);

    expect(chain.main).toHaveLength(1);
    expect(chain.essential).toHaveLength(1);
  });
});
