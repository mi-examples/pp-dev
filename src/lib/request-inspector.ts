import type { Application } from 'express';
import { RequestStore } from './request-store.js';
import { CLIENT_DIST_DIR, serveClientPage } from './client-page.js';
import { decodeContent } from './helpers/content-encoding.helper.js';

export const INSPECTOR_PATH = '/@pp-dev/inspector';

const DEFAULT_LIST_LIMIT = 500;

interface InspectorRouteState {
  store: RequestStore;
  captureLimit: number;
}

const routeStates = new WeakMap<Application, InspectorRouteState>();

/**
 * A captured response body as the page shows, copies and saves it: unpacked when it went to the
 * browser compressed (`Content-Encoding` gzip, br or deflate, as Next.js sends its chunks), as
 * captured otherwise. One that doesn't unpack, or has several encodings, stays as captured. The
 * capture limit counts the compressed bytes, so the unpacked ones are limited to it too: past it,
 * `null` (too large to show), rather than unpacking it all into memory at once.
 */
function readableResponseBody(body: Buffer, contentEncoding: string, maxLength: number): Buffer | null {
  try {
    return decodeContent(body, contentEncoding.trim().toLowerCase(), { maxOutputLength: maxLength });
  } catch (error) {
    return error instanceof RangeError ? null : body;
  }
}

/** A query parameter as one string: Express gives an array for `?search=a&search=b`. */
function firstQueryValue(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;

  return typeof first === 'string' ? first : undefined;
}

/**
 * The Request Inspector's API and page. `clientDir` holds the built page (dist/client); tests pass
 * their own.
 */
export function registerInspectorRoutes(
  app: Application,
  store: RequestStore,
  captureLimit = 10 * 1024 * 1024,
  clientDir = CLIENT_DIST_DIR,
): void {
  const existing = routeStates.get(app);

  if (existing) {
    existing.store = store;
    existing.captureLimit = captureLimit;

    return;
  }

  const current: InspectorRouteState = { store, captureLimit };

  routeStates.set(app, current);

  // ── API: list requests ────────────────────────────────────────────────────────
  app.get('/@api/requests', (req, res) => {
    const { store: activeStore } = current;
    const limit = firstQueryValue(req.query.limit);
    const offset = firstQueryValue(req.query.offset);
    const method = firstQueryValue(req.query.method);
    const search = firstQueryValue(req.query.search);
    const parsedLimit = limit !== undefined ? parseInt(limit, 10) : undefined;
    const items = activeStore.list({
      limit: Number.isFinite(parsedLimit) ? parsedLimit : DEFAULT_LIST_LIMIT,
      offset:
        offset !== undefined ? (Number.isFinite(parseInt(offset, 10)) ? parseInt(offset, 10) : undefined) : undefined,
      method,
      search,
    });

    res.json({
      requests: items,
      total: activeStore.size,
      memoryUsage: activeStore.memoryUsage,
      maxMemory: activeStore.maxMemory,
    });
  });

  // ── API: stats ────────────────────────────────────────────────────────────────
  app.get('/@api/requests/stats', (_req, res) => {
    const { store: activeStore } = current;

    res.json({
      total: activeStore.size,
      memoryUsage: activeStore.memoryUsage,
      maxMemory: activeStore.maxMemory,
      memoryUsageFormatted: formatBytes(activeStore.memoryUsage),
      maxMemoryFormatted: formatBytes(activeStore.maxMemory),
    });
  });

  // ── API: get single request with bodies ───────────────────────────────────────
  app.get('/@api/requests/:id', (req, res) => {
    const entry = current.store.get(req.params.id);

    if (!entry) {
      res.status(404).json({ error: 'Not found', id: req.params.id });

      return;
    }

    const requestContentType = normalizeHeaderValue(entry.requestHeaders['content-type']);
    const responseContentType = normalizeHeaderValue(entry.responseHeaders['content-type']);
    const responseBody = entry.responseBody
      ? readableResponseBody(
          entry.responseBody,
          normalizeHeaderValue(entry.responseHeaders['content-encoding']),
          current.captureLimit,
        )
      : null;

    res.json({
      id: entry.id,
      timestamp: entry.timestamp,
      method: entry.method,
      url: entry.url,
      statusCode: entry.statusCode,
      duration: entry.duration,
      source: entry.source,
      user: entry.user,
      requestHeaders: entry.requestHeaders,
      requestBody: entry.requestBody ? entry.requestBody.toString('base64') : null,
      requestBodySize: entry.requestBody?.byteLength ?? 0,
      requestBodyTruncated: entry.requestBodyTruncated,
      requestContentType,
      responseHeaders: entry.responseHeaders,
      responseBody: responseBody ? responseBody.toString('base64') : null,
      responseBodySize: entry.responseBody?.byteLength ?? 0,
      // Too large unpacked counts as too large to capture: the page says so instead of a body.
      responseBodyTruncated: entry.responseBodyTruncated || (entry.responseBody !== null && responseBody === null),
      responseContentType,
    });
  });

  // ── API: clear all requests ───────────────────────────────────────────────────
  app.delete('/@api/requests', (_req, res) => {
    current.store.clear();
    res.json({ ok: true });
  });

  // ── Web UI ────────────────────────────────────────────────────────────────────
  // The page, built from src/client/request-inspector into dist/client, and its script and styles.
  serveClientPage(app, {
    path: INSPECTOR_PATH,
    name: 'request-inspector',
    clientDir,
    values: () => ({ captureLimit: String(current.captureLimit) }),
  });
}

function normalizeHeaderValue(v: string | string[] | number | undefined): string {
  if (Array.isArray(v)) {
    return v[0] ?? '';
  }

  return String(v ?? '');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
