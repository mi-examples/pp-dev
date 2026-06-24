import { IncomingMessage, ServerResponse } from 'node:http';
import { RequestStore, type RequestSource } from './request-store.js';

const DEFAULT_CAPTURE_LIMIT = 10 * 1024 * 1024;

const SKIP_PREFIXES = ['/@pp-dev/', '/@api/', '/_next/', '/__nextjs_', '/@vite', '/@metricinsights', '/@'];

const SKIP_EXACT = new Set(['/favicon.ico', '/installHook.js.map']);

export function createRequestCaptureMiddleware(store: RequestStore, captureLimit = DEFAULT_CAPTURE_LIMIT) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = req.url || '/';
    const pathname = url.split('?')[0];

    if (SKIP_PREFIXES.some((p) => url.startsWith(p)) || SKIP_EXACT.has(pathname)) {
      next();

      return;
    }

    const id = store.allocateId();
    const startTime = Date.now();

    // Capture request body by tapping into data events without consuming the stream
    const reqChunks: Buffer[] = [];
    let reqSize = 0;
    let reqTruncated = false;

    req.on('data', (chunk: Buffer | string) => {
      if (reqTruncated) {
        return;
      }

      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

      reqSize += buf.byteLength;

      if (reqSize <= captureLimit) {
        reqChunks.push(buf);
      } else {
        reqTruncated = true;
        reqChunks.length = 0; // free memory for partial chunks
      }
    });

    // Capture response body by wrapping write/end
    const resChunks: Buffer[] = [];
    let resSize = 0;
    let resTruncated = false;

    const origWrite = res.write.bind(res) as typeof res.write;
    const origEnd = res.end.bind(res) as typeof res.end;

    function captureChunk(chunk: unknown): void {
      if (resTruncated || chunk == null) {
        return;
      }

      try {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(typeof chunk === 'string' ? chunk : String(chunk));

        resSize += buf.byteLength;

        if (resSize <= captureLimit) {
          resChunks.push(buf);
        } else {
          resTruncated = true;
          resChunks.length = 0;
        }
      } catch {
        // ignore encoding errors on capture
      }
    }

    function detectSource(): RequestSource {
      const headers = res.getHeaders();

      if (headers['x-pp-proxy']) {
        return headers['x-pp-cache'] === 'hit' ? 'proxy-cache' : 'proxy';
      }

      return 'local';
    }

    function finalize(): void {
      const requestBody = !reqTruncated && reqChunks.length > 0 ? Buffer.concat(reqChunks) : null;
      const responseBody = !resTruncated && resChunks.length > 0 ? Buffer.concat(resChunks) : null;

      store.add({
        id,
        timestamp: startTime,
        method: req.method || 'GET',
        url,
        statusCode: res.statusCode ?? null,
        duration: Date.now() - startTime,
        source: detectSource(),
        requestHeaders: req.headers as Record<string, string | string[] | undefined>,
        requestBody,
        requestBodyTruncated: reqTruncated,
        responseHeaders: res.getHeaders() as Record<string, number | string | string[] | undefined>,
        responseBody,
        responseBodyTruncated: resTruncated,
      });
    }

    (res as any).write = function (chunk: any, ...args: any[]): boolean {
      captureChunk(chunk);

      return (origWrite as any)(chunk, ...args);
    };

    (res as any).end = function (chunk?: any, ...args: any[]): any {
      if (typeof chunk !== 'function') {
        captureChunk(chunk);
      }

      finalize();

      return (origEnd as any)(chunk, ...args);
    };

    next();
  };
}
