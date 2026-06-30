import express, { Request, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';
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
    /** UTF-8 text for text responses; base64-encoded for binary (bodyEncoding === 'base64'). */
    body: string;
    bodyEncoding?: 'base64';
  };
}

function isBinaryContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const t = contentType.split(';')[0].trim().toLowerCase();
  return (
    !t.startsWith('text/') &&
    t !== 'application/json' &&
    t !== 'application/javascript' &&
    t !== 'application/xml' &&
    t !== 'application/x-www-form-urlencoded'
  );
}

export interface Cassette {
  name: string;
  baseUrl: string;
  recordedAt: string;
  interactions: Interaction[];
}

export const CASSETTES_DIR = path.resolve(__dirname, 'cassettes');
export const DEFAULT_PORT = 7331;
const FILESYSTEM_PATH_RE = /\/(?:opt|var|srv|usr|home)\/[^\s"'<>),\]}]+/g;

function cassetteKey(method: string, pathname: string): string {
  return `${method.toUpperCase()}:${pathname}`;
}

function redactFilesystemPaths(value: string): string {
  return value.replace(FILESYSTEM_PATH_RE, '[REDACTED_PATH]');
}

function sanitizeHeaders(headers: Record<string, string | string[]>): Record<string, string | string[]> {
  const allowedHeaders = new Set([
    'accept-ranges',
    'cache-control',
    'content-type',
    'etag',
    'expires',
    'last-modified',
    'pragma',
    'vary',
  ]);

  return Object.fromEntries(
    Object.entries(headers).filter(([header]) => allowedHeaders.has(header.toLowerCase())),
  ) as Record<string, string | string[]>;
}

function sanitizeJsonValue(value: unknown, parentKey = ''): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item, parentKey));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, sanitizeJsonValue(nestedValue, key)]),
    );
  }

  const key = parentKey.toLowerCase();

  if (typeof value === 'number' && /user_id|userId|created_by|updated_by/.test(key)) {
    return 1;
  }

  if (typeof value !== 'string') {
    return value;
  }

  if (/token|secret|password|session|cookie|authorization/.test(key)) {
    return '[REDACTED]';
  }

  if (/email/.test(key)) {
    return 'mock-ci';
  }

  if (/username|login|display_name|displayname/.test(key)) {
    return 'mock-ci';
  }

  if (/first_name|firstname/.test(key)) {
    return 'Mock';
  }

  if (/last_name|lastname/.test(key)) {
    return 'User';
  }

  return redactFilesystemPaths(value);
}

function sanitizeTextBody(body: string): string {
  return body
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'mock-ci')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/(["']?(?:access_)?token["']?\s*[:=]\s*["'])[^\"']+(["'])/gi, '$1[REDACTED]$2')
    .replace(/(["']?session(?:_id)?["']?\s*[:=]\s*["'])[^\"']+(["'])/gi, '$1[REDACTED]$2')
    .replace(/(["']?email["']?\s*[:=]\s*["'])[^\"']+(["'])/gi, '$1mock-ci$2')
    .replace(/(["']?user_name["']?\s*[:=]\s*["'])[^\"']+(["'])/gi, '$1mock-ci$2')
    .replace(/(["']?username["']?\s*[:=]\s*["'])[^\"']+(["'])/gi, '$1mock-ci$2')
    .replace(/(["']?first_name["']?\s*[:=]\s*["'])[^\"']+(["'])/gi, '$1Mock$2')
    .replace(/(["']?last_name["']?\s*[:=]\s*["'])[^\"']+(["'])/gi, '$1User$2')
    .replace(FILESYSTEM_PATH_RE, '[REDACTED_PATH]');
}

function sanitizeBody(body: string, contentType: string): string {
  if (contentType.toLowerCase().includes('application/json')) {
    try {
      return JSON.stringify(sanitizeJsonValue(JSON.parse(body)));
    } catch {
      // Fall through to text redaction for malformed JSON/JSONP.
    }
  }

  return sanitizeTextBody(body);
}

function sanitizeCassette(cassette: Cassette): Cassette {
  return {
    ...cassette,
    interactions: cassette.interactions.map((interaction) => {
      if (interaction.request.pathname === '/auth/info.js') {
        return {
          ...interaction,
          response: {
            status: 200,
            headers: { 'content-type': 'application/javascript; charset=utf-8' },
            body: 'window.miAuthInfo = { authenticated: true, user: { username: "mock-ci" } };\n',
          },
        };
      }

      if (interaction.request.pathname === '/js/main.js') {
        return {
          ...interaction,
          response: {
            status: 200,
            headers: { 'content-type': 'application/javascript; charset=utf-8' },
            body: 'window.MI = window.MI || {};\n',
          },
        };
      }

      if (interaction.request.pathname === '/css/main.css') {
        return {
          ...interaction,
          response: {
            status: 200,
            headers: { 'content-type': 'text/css; charset=utf-8' },
            body: '/* Mock MI top bar styles for pp-dev E2E tests. */\n',
          },
        };
      }

      if (/^\/api\/page_template\/id\/\d+\/asset\/download$/.test(interaction.request.pathname)) {
        return {
          ...interaction,
          response: {
            status: 404,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ error: 'Template asset download omitted from cassette' }),
          },
        };
      }

      const headers = sanitizeHeaders(interaction.response.headers);
      const contentType = String(headers['content-type'] ?? headers['Content-Type'] ?? '');

      return {
        ...interaction,
        response: {
          ...interaction.response,
          headers,
          body:
            interaction.response.bodyEncoding === 'base64'
              ? interaction.response.body
              : sanitizeBody(interaction.response.body, contentType),
        },
      };
    }),
  };
}

export function loadCassette(name: string): Cassette {
  const file = path.join(CASSETTES_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Cassette not found: ${file}\nRun "npm run record:mi" with VPN enabled to record it.`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '')) as Cassette;
}

export function saveCassette(cassette: Cassette): void {
  fs.mkdirSync(CASSETTES_DIR, { recursive: true });
  const file = path.join(CASSETTES_DIR, `${cassette.name}.json`);
  fs.writeFileSync(file, JSON.stringify(sanitizeCassette(cassette), null, 2));
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
      const body =
        interaction.response.bodyEncoding === 'base64'
          ? Buffer.from(interaction.response.body, 'base64')
          : interaction.response.body;
      res.end(body);
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
            proxyRes.on('end', () => {
              const rawBuffer = Buffer.concat(chunks);
              const url = new URL(req.url ?? '/', `http://localhost:${port}`);
              const key = cassetteKey(req.method ?? 'GET', url.pathname);
              const encodingHeader = proxyRes.headers['content-encoding'];
              const encoding = String(Array.isArray(encodingHeader) ? encodingHeader[0] : encodingHeader ?? '').toLowerCase();

              // Decompress so cassette bodies are plain text/JSON
              let bodyBuffer = rawBuffer;
              const storedHeaders = Object.fromEntries(
                Object.entries(proxyRes.headers)
                  .filter(([, v]) => v !== undefined)
                  .map(([k, v]) => [k, Array.isArray(v) ? v : String(v)]),
              ) as Record<string, string | string[]>;

              if (encoding === 'gzip' || encoding === 'x-gzip' || encoding === 'br' || encoding === 'deflate') {
                try {
                  if (encoding === 'br') {
                    bodyBuffer = zlib.brotliDecompressSync(rawBuffer);
                  } else if (encoding === 'deflate') {
                    bodyBuffer = zlib.inflateSync(rawBuffer);
                  } else {
                    bodyBuffer = zlib.gunzipSync(rawBuffer);
                  }
                  delete storedHeaders['content-encoding'];
                  storedHeaders['content-length'] = String(bodyBuffer.byteLength);
                } catch {
                  // keep raw bytes if decompression fails
                }
              }

              // Update map so the last response for each endpoint wins
              const contentType = String(storedHeaders['content-type'] ?? '');
              const binary = isBinaryContentType(contentType);
              interactionMap.set(key, {
                request: { method: req.method ?? 'GET', pathname: url.pathname },
                response: {
                  status: proxyRes.statusCode ?? 200,
                  headers: storedHeaders,
                  body: binary ? bodyBuffer.toString('base64') : bodyBuffer.toString('utf-8'),
                  ...(binary && { bodyEncoding: 'base64' as const }),
                },
              });

              console.log(`[mock-mi:record] ${req.method} ${url.pathname} → ${proxyRes.statusCode}`);

              // Forward original (compressed) response to pp-dev unchanged
              res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers as http.OutgoingHttpHeaders);
              res.end(rawBuffer);
            });
          },
          error(err: Error, _req: http.IncomingMessage, res: http.ServerResponse | net.Socket) {
            console.error('[mock-mi:record] Proxy error:', err.message);
            if (res instanceof http.ServerResponse) {
              res.writeHead(502, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
            }
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
