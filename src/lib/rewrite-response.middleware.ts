import type { Connect } from 'vite';
import { decodeContent, encodeContent } from './helpers/content-encoding.helper.js';
import type { ServerResponse } from 'http';
import { createLogger } from './logger.js';

type NextHandleFunction = Connect.NextHandleFunction;
type IncomingMessage = Connect.IncomingMessage;

function asEncoding(value: unknown): BufferEncoding | undefined {
  return typeof value === 'string' ? (value as BufferEncoding) : undefined;
}

function toBuffer(chunk: unknown, encoding?: BufferEncoding): Buffer | null {
  if (typeof chunk === 'string') {
    return Buffer.from(chunk, encoding);
  }

  // A copy, not a view: once a write is acknowledged, its producer may reuse the buffer, and the
  // bytes are needed until `end()`.
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }

  return null;
}

/**
 * Sets the headers given to `writeHead()` on the response, as `writeHead()` would (over earlier
 * `setHeader()` calls): an object, or Node's raw form, a flat list of names and values in which a
 * name may repeat (Set-Cookie).
 */
function setHeadHeaders(res: ServerResponse, headers: unknown) {
  if (Array.isArray(headers)) {
    const byName = new Map<string, { name: string; values: string[] }>();

    for (let i = 0; i + 1 < headers.length; i += 2) {
      const name = String(headers[i]);
      const entry = byName.get(name.toLowerCase()) ?? { name, values: [] };

      entry.values.push(String(headers[i + 1]));
      byName.set(name.toLowerCase(), entry);
    }

    for (const { name, values } of byName.values()) {
      res.setHeader(name, values.length === 1 ? values[0] : values);
    }

    return;
  }

  if (headers && typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      if (value !== undefined) {
        res.setHeader(name, value as number | string | readonly string[]);
      }
    }
  }
}

/**
 * Rewrite response middleware
 *
 * @param predicate Check if need to rewrite response data
 * @param rewrite Rewrite response content handler
 */
export function initRewriteResponse(
  predicate: (url: string, req: IncomingMessage, res: ServerResponse<IncomingMessage>) => Promise<boolean> | boolean,
  rewrite: (response: Buffer, req: IncomingMessage, res: ServerResponse<IncomingMessage>) => Buffer,
): NextHandleFunction {
  return async (req, res, next) => {
    if (await predicate(req.url ?? '', req, res)) {
      const logger = createLogger();

      const end = res.end;

      // A HEAD response has no body to rewrite: the renderer sends the GET page's Content-Length
      // and ends without one. That length is not the rewritten page's, and rewriting an empty body
      // would not give it either, so the header is dropped.
      if (req.method === 'HEAD') {
        res.end = function (chunk?: any, encoding?: any, cb?: any) {
          const callback = [chunk, encoding, cb].find((arg) => typeof arg === 'function');

          if (!res.headersSent) {
            res.removeHeader('content-length');
          }

          (end as (this: ServerResponse, cb?: () => void) => ServerResponse).call(this, callback);

          return this;
        };

        next();

        return;
      }

      logger.info(`Rewrite response for ${req.url}`);

      const buffers: Buffer[] = [];

      // The headers, the page's Content-Length among them, are held back until end(): sent before
      // it, they could no longer give the rewritten body's length, and the page was cut short.
      // Next.js flushes them before it writes the first chunk (pipe-readable.js), and its
      // compression middleware, wrapping end() over this one, writes them (writeHead) before it
      // passes the page on when the client accepts no compression.
      // Its headers are set now, so the rewrite reads them (Content-Encoding) and end() can give
      // the length; only the status waits.
      const writeHead = res.writeHead;
      let heldHead: [number, string?] | null = null;

      res.flushHeaders = function () {};
      res.writeHead = function (this: ServerResponse, statusCode: number, ...rest: unknown[]) {
        const statusMessage = typeof rest[0] === 'string' ? rest[0] : undefined;

        setHeadHeaders(this, statusMessage === undefined ? rest[0] : rest[1]);
        this.statusCode = statusCode;
        heldHead = statusMessage === undefined ? [statusCode] : [statusCode, statusMessage];

        return this;
      };

      res.write = function (chunk: any, encoding?: any, cb?: any) {
        const buffer = toBuffer(chunk, asEncoding(encoding));

        if (buffer) {
          buffers.push(buffer);
        }

        const callback = typeof encoding === 'function' ? encoding : cb;

        // Asynchronously, as a real response calls it: a producer that writes its next chunk from
        // the callback would otherwise recurse on one stack for the whole body.
        if (typeof callback === 'function') {
          process.nextTick(callback);
        }

        return true;
      };

      res.end = function (chunk?: any, encoding?: any, cb?: any) {
        if (typeof chunk === 'function') {
          cb = chunk;
          chunk = undefined;
        }

        const buffer = toBuffer(chunk, asEncoding(encoding));

        if (buffer) {
          buffers.push(buffer);
        }

        const endCallback = typeof encoding === 'function' ? encoding : cb;

        const contentEncoding = res.getHeader('content-encoding') as string | undefined;
        const content = decodeContent(Buffer.concat(buffers), contentEncoding);
        const output = encodeContent(rewrite(content, req, res), contentEncoding);

        // Next.js sets `Content-Length` for the page it rendered before calling `end`
        // (send-payload.js). The rewritten body is longer, and a stale length makes browsers
        // cut the page short and Node clients fail with HPE_INVALID_CONSTANT. Vite sets none.
        if (res.getHeader('content-length') !== undefined) {
          if (res.headersSent) {
            logger.warn(`Rewrite response for ${req.url}: headers already sent, Content-Length left as is`);
          } else {
            res.setHeader('content-length', output.length);
          }
        }

        res.writeHead = writeHead;

        if (heldHead && !res.headersSent) {
          (writeHead as (...args: unknown[]) => ServerResponse).apply(this, heldHead);
        }

        end.call(this, output, endCallback);

        return this;
      };
    }

    next();
  };
}
