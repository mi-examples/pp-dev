import { Connect } from 'vite';
import NextHandleFunction = Connect.NextHandleFunction;
import { decodeContent, encodeContent } from './helpers/content-encoding.helper.js';
import type { ServerResponse } from 'http';

/**
 * Rewrite response middleware
 *
 * @param predicate Check if need to rewrite response data
 * @param rewrite Rewrite response content handler
 */
export function initRewriteResponse(
  predicate: (url: string, req: Connect.IncomingMessage, res: ServerResponse<Connect.IncomingMessage>) => boolean,
  rewrite: (response: Buffer, req: Connect.IncomingMessage, res: ServerResponse<Connect.IncomingMessage>) => Buffer,
): NextHandleFunction {
  return (req, res, next) => {
    if (predicate(req.url ?? '', req, res)) {
      const end = res.end;

      const buffers: Buffer[] = [];

      res.write = function (body) {
        buffers.push(body);

        return true;
      };

      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      res.end = function (chunk: any, encoding: BufferEncoding, cb?: () => void) {
        if (typeof chunk === 'string') {
          buffers.push(Buffer.from(chunk));
        }

        const contentEncoding = res.getHeader('content-encoding') as string;
        const content = decodeContent(Buffer.from(Buffer.concat(buffers)), contentEncoding);

        end.call(this, encodeContent(rewrite(content, req, res), contentEncoding), encoding, cb);
      };
    }

    next();
  };
}
