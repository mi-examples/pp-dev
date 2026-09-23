import { ViteDevServer } from 'vite';
import { PROXY_HEADER } from './proxy-pass.middleware.js';
import type { Connect } from 'vite';
import { Express } from 'express';
import { createLogger } from './logger.js';
import { colors } from './helpers/color.helper.js';
import { ServerResponse } from 'http';

type NextHandleFunction = Connect.NextHandleFunction;

export interface CacheItem {
  headers: Record<string, any>;
  content: Buffer;
  timestamp: number;
  size: number;
}

export interface ProxyCacheOpts {
  devServer: ViteDevServer | Express;
  ttl?: number;
  maxSize?: number; // Maximum cache size in bytes
  maxItems?: number; // Maximum number of cache items
}

declare module 'vite' {
  interface ViteDevServer {
    cache?: ProxyCache;
  }
}

// Optimized regex for file extensions - compiled once
const FILE_EXTENSION_REGEX = /\.(?:[a-z0-9]+)$/i;

// Cache configuration with better defaults
const DEFAULT_TTL = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_SIZE = 100 * 1024 * 1024; // 100MB
const DEFAULT_MAX_ITEMS = 1000;

/**
 * In-memory TTL cache with item-count and total-size limits.
 *
 * Expired entries are dropped lazily (on read, and on every write). A Map iterates in insertion
 * order and `put` re-inserts, so the first key is always the oldest write — eviction is O(1)
 * instead of sorting every key by timestamp.
 */
export class ProxyCache<V extends { size: number } = CacheItem> {
  private readonly items = new Map<string, { value: V; expiresAt: number }>();
  private totalSize = 0;
  public maxSize: number;
  public maxItems: number;

  constructor(maxSize: number, maxItems: number) {
    this.maxSize = maxSize;
    this.maxItems = maxItems;
  }

  get(key: string): V | null {
    const entry = this.items.get(key);

    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.del(key);

      return null;
    }

    return entry.value;
  }

  put(key: string, value: V, ttl = DEFAULT_TTL): V {
    this.del(key);
    this.items.set(key, { value, expiresAt: Date.now() + ttl });
    this.totalSize += value.size;
    this.cleanup();

    return value;
  }

  del(key: string): boolean {
    const entry = this.items.get(key);

    if (!entry) {
      return false;
    }

    this.totalSize -= entry.value.size;

    return this.items.delete(key);
  }

  clear(): void {
    this.items.clear();
    this.totalSize = 0;
  }

  keys(): string[] {
    this.purgeExpired();

    return [...this.items.keys()];
  }

  getTotalSize(): number {
    return this.totalSize;
  }

  getItemCount(): number {
    return this.keys().length;
  }

  private purgeExpired(): void {
    const now = Date.now();

    for (const [key, entry] of this.items) {
      if (entry.expiresAt <= now) {
        this.del(key);
      }
    }
  }

  private cleanup(): void {
    this.purgeExpired();

    while (this.items.size > 0 && (this.items.size > this.maxItems || this.totalSize > this.maxSize)) {
      this.del(this.items.keys().next().value as string);
    }
  }
}

// Shared cache instance
const cache = new ProxyCache(DEFAULT_MAX_SIZE, DEFAULT_MAX_ITEMS);

/**
 * Generates an optimized cache key from URL and query parameters
 */
function generateCacheKey(url: string): string {
  // Remove query parameters for better cache hit rates
  const cleanUrl = url.split('?')[0];

  // Only cache files with extensions
  if (!FILE_EXTENSION_REGEX.test(cleanUrl)) {
    return '';
  }

  if (cleanUrl.includes('/auth/info.js')) {
    return '';
  }

  return url;
}

/**
 * Creates a response buffer from chunks
 */
function createResponseBuffer(chunks: Buffer[]): Buffer {
  if (chunks.length === 0) {
    return Buffer.alloc(0);
  }

  if (chunks.length === 1) {
    return chunks[0];
  }

  const totalLength = chunks.reduce((sum, chunk) => Buffer.byteLength(chunk) + sum, 0);

  return Buffer.concat(chunks as unknown as Uint8Array[], totalLength);
}

/**
 * Safely sets response headers
 */
function setResponseHeaders(res: ServerResponse, headers: Record<string, any>): void {
  try {
    for (const [header, value] of Object.entries(headers)) {
      if (value !== undefined && value !== null) {
        res.setHeader(header, value);
      }
    }
  } catch (error) {
    // Log header setting errors but don't fail the request
    createLogger().warn(
      `Failed to set some response headers: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function initProxyCache(opts: ProxyCacheOpts): NextHandleFunction {
  const { devServer, ttl = DEFAULT_TTL, maxSize = DEFAULT_MAX_SIZE, maxItems = DEFAULT_MAX_ITEMS } = opts;

  const logger = createLogger();

  // Update cache limits if provided
  if (maxSize !== DEFAULT_MAX_SIZE || maxItems !== DEFAULT_MAX_ITEMS) {
    cache.maxSize = maxSize;
    cache.maxItems = maxItems;
  }

  devServer.cache = cache;

  return (req, res, next) => {
    const url = req.originalUrl || req.url || '';
    const cacheKey = generateCacheKey(url);

    // Skip caching if no valid cache key
    if (!cacheKey) {
      return next();
    }

    // Check cache for existing item
    const cacheItem = cache.get(cacheKey);

    if (cacheItem) {
      logger.info(
        `${colors.blue('Proxies request:')} ${colors.green(req.method)} ${url} -> ${colors.blue('Cache')} ${cacheKey}`,
      );

      setResponseHeaders(res, cacheItem.headers);
      res.setHeader('X-PP-Cache', 'hit');

      res.write(cacheItem.content);
      res.end();

      return;
    }

    // Store original methods
    const originalEnd = res.end;
    const originalWrite = res.write;
    const chunks: Buffer[] = [];

    // Override write method to capture response data
    (res as any).write = function (
      data: any,
      encoding?: BufferEncoding,
      callback?: (error?: Error | null) => void,
    ): boolean {
      if (!res.hasHeader(PROXY_HEADER)) {
        return originalWrite.call(this, data, encoding as BufferEncoding, callback);
      }

      // Convert data to Buffer and store
      if (typeof data === 'string') {
        const safeEncoding: BufferEncoding = encoding || 'utf8';

        chunks.push(Buffer.from(data, safeEncoding));
      } else if (Buffer.isBuffer(data)) {
        chunks.push(data);
      } else if (data !== null && data !== undefined) {
        chunks.push(Buffer.from(String(data), 'utf8'));
      }

      callback?.();

      return true;
    };

    // Override end method to finalize response and cache
    (res as any).end = function (chunk?: any, encoding?: BufferEncoding, callback?: () => void): ServerResponse {
      if (!res.hasHeader(PROXY_HEADER)) {
        return originalEnd.call(this, chunk, encoding as BufferEncoding, callback);
      }

      // Add final chunk if provided
      if (chunk !== undefined && chunk !== null) {
        if (typeof chunk === 'string') {
          const safeEncoding: BufferEncoding = encoding || 'utf8';

          chunks.push(Buffer.from(chunk, safeEncoding));
        } else if (Buffer.isBuffer(chunk)) {
          chunks.push(chunk);
        } else {
          chunks.push(Buffer.from(String(chunk), 'utf8'));
        }
      }

      // Create final buffer and cache response
      let finalBuffer: Buffer;

      try {
        finalBuffer = createResponseBuffer(chunks);

        const responseSize = Buffer.byteLength(finalBuffer);

        // Only cache if response is not empty and reasonable size
        if (responseSize > 0 && responseSize < 10 * 1024 * 1024) {
          // Max 10MB per item
          const cacheItem: CacheItem = {
            headers: res.getHeaders(),
            content: finalBuffer,
            timestamp: Date.now(),
            size: responseSize,
          };

          cache.put(cacheKey, cacheItem, ttl);

          logger.info(`${colors.blue('[Cached]')} ${cacheKey} (${(responseSize / 1024).toFixed(1)}KB)`);
        }
      } catch (error) {
        logger.error(`Failed to cache response for ${cacheKey}: ${error}`);
        finalBuffer = createResponseBuffer(chunks);
      }

      // Send response with proper encoding handling
      const finalEncoding = encoding || 'utf8';

      return originalEnd.call(this, finalBuffer, finalEncoding as BufferEncoding, callback);
    };

    next();
  };
}

// Export cache statistics for monitoring
export function getCacheStats() {
  return {
    totalSize: cache.getTotalSize(),
    itemCount: cache.getItemCount(),
    maxSize: cache.maxSize,
    maxItems: cache.maxItems,
  };
}

// Export cache instance for external access
export { cache };
