import { Connect } from 'vite';
import NextHandleFunction = Connect.NextHandleFunction;
import { decodeContent, encodeContent } from './helpers/content-encoding.helper.js';
import type { ServerResponse } from 'http';
import { createLogger } from './logger.js';

/**
 * Rewrite response middleware
 *
 * @param predicate Check if need to rewrite response data
 * @param rewrite Rewrite response content handler
 */
export function initRewriteResponse(
  predicate: (
    url: string,
    req: Connect.IncomingMessage,
    res: ServerResponse<Connect.IncomingMessage>,
  ) => Promise<boolean> | boolean,
  rewrite: (response: Buffer, req: Connect.IncomingMessage, res: ServerResponse<Connect.IncomingMessage>) => Buffer,
): NextHandleFunction {
  return async (req, res, next) => {
    if (await predicate(req.url ?? '', req, res)) {
      const logger = createLogger();

      logger.info(`Rewrite response for ${req.url}`);

      const end = res.end;

      const buffers: Buffer[] = [];

      res.write = function (body) {
        buffers.push(body);

        return true;
      };

      res.end = function (chunk?: any, encoding?: BufferEncoding | (() => void), cb?: () => void) {
        if (typeof chunk === 'string') {
          buffers.push(Buffer.from(chunk));
        }

        const contentEncoding = res.getHeader('content-encoding') as string;
        const content = decodeContent(Buffer.from(Buffer.concat(buffers)), contentEncoding);

        const bufferEncoding = typeof encoding !== 'function' && encoding ? encoding : 'utf-8';
        const endCallback = typeof encoding === 'function' ? encoding : cb;

        end.call(this, encodeContent(rewrite(content, req, res), contentEncoding), bufferEncoding, endCallback);

        return this;
      };
    }

    next();
  };
}
