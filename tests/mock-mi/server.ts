import express, { Request, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type MockMode = 'record' | 'replay';

export interface Interaction {
  request: {
    method: string;
    pathname: string;
  };
  response: {
    status: number;
    headers: Record<string, string | string[]>;
    body: string;
  };
}

export interface Cassette {
  name: string;
  baseUrl: string;
  recordedAt: string;
  interactions: Interaction[];
}

export const CASSETTES_DIR = path.resolve(__dirname, 'cassettes');
export const DEFAULT_PORT = 7331;

function cassetteKey(method: string, pathname: string): string {
  return `${method.toUpperCase()}:${pathname}`;
}

export function loadCassette(name: string): Cassette {
  const file = path.join(CASSETTES_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Cassette not found: ${file}\nRun "npm run record:mi" with VPN enabled to record it.`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Cassette;
}

export function saveCassette(cassette: Cassette): void {
  fs.mkdirSync(CASSETTES_DIR, { recursive: true });
  const file = path.join(CASSETTES_DIR, `${cassette.name}.json`);
  fs.writeFileSync(file, JSON.stringify(cassette, null, 2));
  console.log(`[mock-mi] Saved ${cassette.interactions.length} interactions → ${file}`);
}

export interface MockMiServer {
  url: string;
  /** Only available in record mode — call before close() to persist the cassette. */
  save?(): void;
  close(): Promise<void>;
}

export async function startMockMiServer(opts: {
  mode: MockMode;
  port?: number;
  cassetteName?: string;
  realMiUrl?: string;
}): Promise<MockMiServer> {
  const {
    mode,
    port = DEFAULT_PORT,
    cassetteName = 'startup',
    realMiUrl = process.env.REAL_MI_URL ?? 'https://stg7x.metricinsights.com',
  } = opts;

  const app = express();
  let cassetteSave: (() => void) | undefined;

  // ── Replay mode ──────────────────────────────────────────────────────────
  if (mode === 'replay') {
    const cassette = loadCassette(cassetteName);
    const map = new Map<string, Interaction>();

    // Last-response-wins: the final state after any auth/login sequence
    for (const interaction of cassette.interactions) {
      map.set(cassetteKey(interaction.request.method, interaction.request.pathname), interaction);
    }

    app.use((req: Request, res: Response) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      const key = cassetteKey(req.method, url.pathname);
      const interaction = map.get(key);

      if (!interaction) {
        console.warn(`[mock-mi:replay] No cassette entry for ${key}`);
        res.status(404).json({ error: 'Not in cassette', path: url.pathname });
        return;
      }

      res.status(interaction.response.status);
      for (const [header, value] of Object.entries(interaction.response.headers)) {
        try {
          res.setHeader(header, value);
        } catch {
          // skip headers that Node rejects
        }
      }
      res.end(interaction.response.body);
    });
  }

  // ── Record mode ───────────────────────────────────────────────────────────
  if (mode === 'record') {
    const interactionMap = new Map<string, Interaction>();

    app.use(
      createProxyMiddleware({
        target: realMiUrl,
        changeOrigin: true,
        selfHandleResponse: true,
        on: {
          proxyRes(proxyRes: http.IncomingMessage, req: http.IncomingMessage, res: http.ServerResponse) {
            const chunks: Buffer[] = [];
            proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
            proxyRes.on('end', async () => {
              const rawBuffer = Buffer.concat(chunks);
              const url = new URL(req.url ?? '/', `http://localhost:${port}`);
              const key = cassetteKey(req.method ?? 'GET', url.pathname);
              const encoding = proxyRes.headers['content-encoding'];

              // Decompress so cassette bodies are plain text/JSON
              let bodyBuffer = rawBuffer;
              const storedHeaders = Object.fromEntries(
                Object.entries(proxyRes.headers)
                  .filter(([, v]) => v !== undefined)
                  .map(([k, v]) => [k, Array.isArray(v) ? v : String(v)]),
              ) as Record<string, string | string[]>;

              if (encoding === 'gzip' || encoding === 'x-gzip') {
                try {
                  bodyBuffer = await new Promise<Buffer<ArrayBuffer>>((ok, fail) =>
                    zlib.gunzip(rawBuffer, (err, result) => (err ? fail(err) : ok(result))),
                  );
                  delete storedHeaders['content-encoding'];
                  storedHeaders['content-length'] = String(bodyBuffer.byteLength);
                } catch {
                  // keep raw bytes if decompression fails
                }
              }

              // Update map so the last response for each endpoint wins
              interactionMap.set(key, {
                request: { method: req.method ?? 'GET', pathname: url.pathname },
                response: {
                  status: proxyRes.statusCode ?? 200,
                  headers: storedHeaders,
                  body: bodyBuffer.toString('utf-8'),
                },
              });

              console.log(`[mock-mi:record] ${req.method} ${url.pathname} → ${proxyRes.statusCode}`);

              // Forward original (compressed) response to pp-dev unchanged
              res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers as http.OutgoingHttpHeaders);
              res.end(rawBuffer);
            });
          },
          error(err: Error, _req: http.IncomingMessage, res: http.ServerResponse) {
            console.error('[mock-mi:record] Proxy error:', err.message);
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          },
        },
      } as Parameters<typeof createProxyMiddleware>[0]),
    );

    // Save cassette — also called explicitly by record-auto.ts before exit
    cassetteSave = () => {
      if (interactionMap.size === 0) {
        console.warn('[mock-mi:record] No interactions captured; cassette not saved.');
        return;
      }
      saveCassette({
        name: cassetteName,
        baseUrl: realMiUrl,
        recordedAt: new Date().toISOString(),
        interactions: Array.from(interactionMap.values()),
      });
    };
    process.once('SIGINT', cassetteSave);
    process.once('SIGTERM', cassetteSave);
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(port, () => {
      const url = `http://localhost:${port}`;
      console.log(`[mock-mi] ${mode} mode → ${url} (target: ${mode === 'record' ? realMiUrl : 'cassette'})`);
      resolve({
        url,
        save: cassetteSave,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
    server.once('error', reject);
  });
}
