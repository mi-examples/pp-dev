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

    // Capture the request body by patching req.emit rather than attaching a 'data'
    // listener: a listener would switch the stream into flowing mode, and buffered
    // chunks would be emitted (and lost) before a downstream consumer — e.g. the
    // proxy — attaches its own reader. Patching emit observes chunks only when
    // something downstream actually reads the stream, leaving its state untouched.
    const reqChunks: Buffer[] = [];
    let reqSize = 0;
    let reqTruncated = false;

    const origReqEmit = req.emit.bind(req);

    req.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
      if (event === 'data' && !reqTruncated) {
        const chunk = args[0];
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));

        reqSize += buf.byteLength;

        if (reqSize <= captureLimit) {
          reqChunks.push(buf);
        } else {
          reqTruncated = true;
          reqChunks.length = 0; // free memory for partial chunks
        }
      }

      return origReqEmit(event as never, ...(args as never[]));
    }) as typeof req.emit;

    // Capture response body by wrapping write/end
    const resChunks: Buffer[] = [];
    let resSize = 0;
    let resTruncated = false;

    const origWrite = res.write.bind(res) as typeof res.write;
    const origEnd = res.end.bind(res) as typeof res.end;

    function captureChunk(chunk: unknown, encoding?: BufferEncoding): void {
      if (resTruncated || chunk == null) {
        return;
      }

      try {
        const buf = Buffer.isBuffer(chunk)
          ? chunk
          : typeof chunk === 'string'
            ? Buffer.from(chunk, encoding)
            : ArrayBuffer.isView(chunk)
              ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
              : chunk instanceof ArrayBuffer
                ? Buffer.from(chunk)
                : Buffer.from(String(chunk));

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

    function getWriteEncoding(args: unknown[]): BufferEncoding | undefined {
      return typeof args[0] === 'string' ? (args[0] as BufferEncoding) : undefined;
    }

    function detectSource(): RequestSource {
      const headers = res.getHeaders();

      if (headers['x-pp-proxy']) {
        return headers['x-pp-cache'] === 'hit' ? 'proxy-cache' : 'proxy';
      }

      return 'local';
    }

    let finalized = false;

    function finalize(): void {
      if (finalized) {
        return;
      }

      finalized = true;

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
      captureChunk(chunk, getWriteEncoding(args));

      return (origWrite as any)(chunk, ...args);
    };

    (res as any).end = function (chunk?: any, ...args: any[]): any {
      if (typeof chunk !== 'function') {
        captureChunk(chunk, getWriteEncoding(args));
      }

      finalize();

      return (origEnd as any)(chunk, ...args);
    };

    next();
  };
}
