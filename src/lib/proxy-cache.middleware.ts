import { Connect, ViteDevServer } from 'vite';
import * as memoryCache from 'memory-cache';
import { PROXY_HEADER } from './proxy-pass.middleware.js';
import NextHandleFunction = Connect.NextHandleFunction;

const cache = new memoryCache.Cache<string, CacheItem>();

export interface ProxyCacheOpts {
  viteDevServer: ViteDevServer;
  ttl?: number;
}

export interface CacheItem {
  headers: Record<string, any>;
  content: any;
}

declare module 'vite' {
  interface ViteDevServer {
    cache?: memoryCache.CacheClass<string, CacheItem>;
  }
}

const testCacheUrlRegExp = /\.[a-z0-9]+$/i;

export function initProxyCache(opts: ProxyCacheOpts): NextHandleFunction {
  const { viteDevServer, ttl = 10 * 60 * 1000 } = opts;

  viteDevServer.cache = cache;

  return (req, res, next) => {
    const url = req.originalUrl || req.url || '';

    if (testCacheUrlRegExp.test(url.split('?')[0] || '')) {
      const cacheItem = cache.get(url);

      if (cacheItem) {
        viteDevServer.config.logger.info(`Proxies request: ${req.method} ${url} -> Cache ${url}`);

        for (const [header, value] of Object.entries(cacheItem.headers)) {
          res.setHeader(header, value);
        }

        res.write(cacheItem.content);
        res.end();

        return;
      }

      const end = res.end;
      const write = res.write;
      let buffer = Buffer.from('', 'utf8');

      // Rewrite response method and get the content.
      res.write = function (data, encoding?, callback?) {
        if (!res.hasHeader(PROXY_HEADER)) {
          return write.call(this, data, encoding as BufferEncoding, callback as any);
        }

        buffer = Buffer.concat([buffer, data]);

        return true;
      };

      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      res.end = function (chunk: string | Buffer, encoding: BufferEncoding, cb?: () => void) {
        if (!res.hasHeader(PROXY_HEADER)) {
          return end.call(this, chunk, encoding, cb);
        }

        if (typeof chunk === 'string') {
          buffer = Buffer.concat([buffer, Buffer.from(chunk, encoding)]);
        }

        if (Buffer.isBuffer(chunk)) {
          buffer = Buffer.concat([buffer, chunk]);
        }

        if (res.hasHeader(PROXY_HEADER)) {
          cache.put(url, { headers: res.getHeaders(), content: buffer }, ttl);
        }

        end.call(this, buffer, encoding, cb);
      };
    }

    next();
  };
}
