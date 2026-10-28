import { ViteDevServer } from 'vite';
import { PROXY_HEADER, getRequestBearerToken } from './proxy-pass.middleware.js';
import type { Connect } from 'vite';
import { Express } from 'express';
import { createLogger } from './logger.js';
import { colors } from './helpers/color.helper.js';
import { ServerResponse } from 'http';
import { MI_SESSION_COOKIE, getRequestCookie, getSetCookieValue } from './helpers/cookie.helper.js';
import { cutUrlParams } from './helpers/url.helper.js';
import { RequestUser, UserRegistry, getUserNameFromHost, userRegistry } from './user-registry.js';

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
  /** Saved users; each one gets its own cache entries. @default the shared {@link userRegistry} */
  users?: UserRegistry;
}

declare module 'vite' {
  interface ViteDevServer {
    cache?: ProxyCache;
  }
}

declare module 'express' {
  interface Express {
    cache?: ProxyCache;
  }
}

// Optimized regex for file extensions - compiled once
const FILE_EXTENSION_REGEX = /\.(?:[a-z0-9]+)$/i;

// Cache configuration with better defaults
const DEFAULT_TTL = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_SIZE = 100 * 1024 * 1024; // 100MB
const DEFAULT_MAX_ITEMS = 1000;

/** The largest body the cache keeps; a larger response goes to the client as it arrives. */
const MAX_CACHED_ITEM_SIZE = 10 * 1024 * 1024;

/**
 * Whether a proxied response may be cached, decided once its headers are set: a 200 that isn't
 * streamed (Server-Sent Events, `X-Accel-Buffering: no`) and doesn't announce a body too large to
 * keep. Anything else must reach the client as it arrives instead of being held until it ends.
 */
function isCacheableResponse(res: ServerResponse): boolean {
  if (res.statusCode !== 200) {
    return false;
  }

  if (/^text\/event-stream/i.test(String(res.getHeader('content-type') ?? ''))) {
    return false;
  }

  if (String(res.getHeader('x-accel-buffering') ?? '').toLowerCase() === 'no') {
    return false;
  }

  const contentLength = Number(res.getHeader('content-length'));

  return !(Number.isFinite(contentLength) && contentLength >= MAX_CACHED_ITEM_SIZE);
}

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

const invalidateListeners = new Set<() => void>();

/** The personal access token of the last proxied request that carried one, per user key. */
const lastBearerTokens = new Map<string, string>();

/**
 * Runs `listener` whenever the proxy cache is dropped because the MI session changed, so other
 * per-session caches can be dropped with it. Returns an unsubscribe function.
 */
export function onProxyCacheInvalidate(listener: () => void): () => void {
  invalidateListeners.add(listener);

  return () => {
    invalidateListeners.delete(listener);
  };
}

/**
 * Drops everything cached for the previous MI session (login, logout, token login). Responses
 * cached while logged out, such as the login redirects MI sends for portal page assets, must not
 * be served once the user is logged in, and the other way round.
 */
export function invalidateProxyCache(reason: string): void {
  cache.clear();
  lastBearerTokens.clear();
  invalidateListeners.forEach((listener) => listener());

  createLogger().info(colors.blue(`Proxy cache cleared: ${reason}`));
}

/** Registries whose removed users already have their cache dropped. */
const watchedRegistries = new WeakSet<UserRegistry>();

/** Whether `cacheKey` holds a response for `userKey` (`''` is the original user). */
function isCacheKeyOf(cacheKey: string, userKey: string): boolean {
  return userKey ? cacheKey.startsWith(`@${userKey}@`) : !cacheKey.startsWith('@');
}

/**
 * Drops what is cached for one saved user (its MI session changed, or it was removed), leaving the
 * other users' entries warm. For the original user (`''`) it drops everything, like
 * {@link invalidateProxyCache}, since per-session caches such as the page data belong to it.
 */
export function invalidateUserProxyCache(userKey: string, reason: string): void {
  if (!userKey) {
    invalidateProxyCache(reason);

    return;
  }

  for (const key of cache.keys()) {
    if (isCacheKeyOf(key, userKey)) {
      cache.del(key);
    }
  }

  lastBearerTokens.delete(userKey);

  createLogger().info(colors.blue(`Proxy cache cleared for ${userKey}: ${reason}`));
}

/**
 * Why a proxied response belongs to another MI identity than the cache was filled for, or
 * `undefined` if it does not.
 *
 * - With a personal access token the token is the identity. MI answers every bearer request with a
 *   new session id, whatever cookie it got, so the cookies say nothing there; only another token
 *   does. Token logins through `/@api/login` clear the cache themselves. Each saved user (`userKey`)
 *   has a token of its own, so tokens are compared per user.
 * - Otherwise MI keeps the session id stable while a session lasts and issues a new one on login
 *   and logout, so a `Set-Cookie` with an id other than the one the request carried marks exactly
 *   those moments.
 */
function getIdentityChange(req: Connect.IncomingMessage, res: ServerResponse, userKey: string): string | undefined {
  const token = getRequestBearerToken(req);

  if (token !== undefined) {
    const lastBearerToken = lastBearerTokens.get(userKey);
    const changed = lastBearerToken !== undefined && token !== lastBearerToken;

    lastBearerTokens.set(userKey, token);

    return changed ? 'personal access token changed' : undefined;
  }

  const newSession = getSetCookieValue(res.getHeader('set-cookie'), MI_SESSION_COOKIE);

  return newSession !== undefined && newSession !== getRequestCookie(req.headers.cookie, MI_SESSION_COOKIE)
    ? 'MI session changed'
    : undefined;
}

/**
 * Whether a response may still be cached for the user it was requested as: not when that user was
 * removed, replaced (removed and added again) or got another MI session while the request was in
 * flight, or the old identity's answer would refill the new one's cache.
 */
function isStillSameIdentity(
  requestUser: RequestUser,
  sessionAtStart: string | undefined,
  users: UserRegistry,
): boolean {
  if (!requestUser.user) {
    return true;
  }

  return users.get(requestUser.key) === requestUser.user && requestUser.user.session === sessionAtStart;
}

/**
 * Whether the request goes to MI with the verified session of its session user. The cache of a
 * session user is only for that session: on its own host the browser sends whatever session it
 * holds (another tab's login, a guest session, a stale cookie), and that answer must neither be
 * cached for the user nor be answered from its cache. On the main host the proxy sends the kept one.
 */
function hasVerifiedSession(req: Connect.IncomingMessage, requestUser: RequestUser): boolean {
  const { user } = requestUser;

  if (user?.kind !== 'session') {
    return true;
  }

  if (!user.session) {
    return false;
  }

  return (
    getUserNameFromHost(req.headers.host) !== user.name ||
    getRequestCookie(req.headers.cookie, MI_SESSION_COOKIE) === user.session
  );
}

/**
 * Generates an optimized cache key from URL and query parameters. A saved user's entries are
 * prefixed with its `userKey`, so one user is never served what MI answered another, and with the
 * host they were requested on: the proxy rewrites absolute URLs in a body to that host, and a
 * default user is served on both `localhost` and its own host.
 */
function generateCacheKey(url: string, userKey: string, host: string): string {
  // Only files with extensions are cached (judged by the path); the key keeps the query.
  const cleanUrl = url.split('?')[0];

  if (!FILE_EXTENSION_REGEX.test(cleanUrl)) {
    return '';
  }

  if (cleanUrl.includes('/auth/info.js')) {
    return '';
  }

  return userKey ? `@${userKey}@${host}:${url}` : url;
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
  const {
    devServer,
    ttl = DEFAULT_TTL,
    maxSize = DEFAULT_MAX_SIZE,
    maxItems = DEFAULT_MAX_ITEMS,
    users = userRegistry,
  } = opts;

  const logger = createLogger();

  // Update cache limits if provided
  if (maxSize !== DEFAULT_MAX_SIZE || maxItems !== DEFAULT_MAX_ITEMS) {
    cache.maxSize = maxSize;
    cache.maxItems = maxItems;
  }

  devServer.cache = cache;

  if (!watchedRegistries.has(users)) {
    watchedRegistries.add(users);
    users.onRemove((user) => invalidateUserProxyCache(user.name, 'user removed'));
    users.onSessionChange((user) => invalidateUserProxyCache(user.name, 'MI session changed or ended'));
  }

  return (req, res, next) => {
    const requestUser = users.resolve(req);

    // A user host with no saved user behind it is never cached.
    if (!requestUser) {
      return next();
    }

    res.once('finish', () => {
      const change = res.hasHeader(PROXY_HEADER) ? getIdentityChange(req, res, requestUser.key) : undefined;

      if (change) {
        invalidateUserProxyCache(requestUser.key, `${change} (${req.method} ${cutUrlParams(req.url ?? '')})`);
      }
    });

    // The MI session a session user had when the request started, to tell whether it changed by the end.
    const sessionAtStart = requestUser.user?.session;
    const url = req.originalUrl || req.url || '';
    const cacheKey = req.method === 'GET' ? generateCacheKey(url, requestUser.key, req.headers.host ?? '') : '';

    // Skip caching if no valid cache key
    if (!cacheKey || !hasVerifiedSession(req, requestUser)) {
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
    let bufferedSize = 0;
    // Decided on the first write or end, once the response's status and headers are known.
    let mode: 'undecided' | 'buffer' | 'pass' = 'undecided';

    const toBuffer = (data: unknown, encoding?: BufferEncoding): Buffer | null => {
      if (data === undefined || data === null) {
        return null;
      }

      if (typeof data === 'string') {
        return Buffer.from(data, encoding || 'utf8');
      }

      // A copy: the producer may reuse its buffer once the write is acknowledged.
      if (data instanceof Uint8Array) {
        return Buffer.from(data);
      }

      return Buffer.from(String(data), 'utf8');
    };

    // Stop capturing: give the response its own write/end back, and send what was held so far.
    const passThrough = () => {
      mode = 'pass';
      res.write = originalWrite;
      res.end = originalEnd;

      for (const held of chunks.splice(0)) {
        (originalWrite as (chunk: Buffer) => boolean).call(res, held);
      }
    };

    const decide = () => {
      if (mode !== 'undecided') {
        return;
      }

      if (!res.hasHeader(PROXY_HEADER)) {
        mode = 'pass';
        res.write = originalWrite;
        res.end = originalEnd;

        return;
      }

      // Only a complete 200 that isn't streamed is ever cached. Anything else goes to the client
      // as it arrives: an event stream used to reach it only once it ended, and a redirect or
      // error was held for nothing.
      if (!isCacheableResponse(res)) {
        passThrough();

        return;
      }

      mode = 'buffer';
    };

    // Override write method to capture response data
    res.write = function (
      this: ServerResponse,
      data: unknown,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean {
      decide();

      if (mode === 'pass') {
        return (originalWrite as (...args: unknown[]) => boolean).call(this, data, encodingOrCallback, callback);
      }

      const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      const buffer = toBuffer(data, encoding);

      if (buffer) {
        chunks.push(buffer);
        bufferedSize += buffer.length;
      }

      // Past the largest item the cache keeps: stop holding the body, send it on as it comes.
      if (bufferedSize > MAX_CACHED_ITEM_SIZE) {
        passThrough();
      }

      if (done) {
        process.nextTick(done);
      }

      return true;
    } as ServerResponse['write'];

    // Override end method to finalize response and cache
    res.end = function (this: ServerResponse, chunk?: unknown, encoding?: unknown, callback?: unknown): ServerResponse {
      decide();

      if (mode === 'pass') {
        return (originalEnd as (...args: unknown[]) => ServerResponse).call(this, chunk, encoding, callback);
      }

      if (typeof chunk === 'function') {
        callback = chunk;
        chunk = undefined;
      } else if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
      }

      // Add final chunk if provided
      const last = toBuffer(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined);

      if (last) {
        chunks.push(last);
      }

      // Create final buffer and cache response
      let finalBuffer: Buffer;

      try {
        finalBuffer = createResponseBuffer(chunks);

        const responseSize = Buffer.byteLength(finalBuffer);

        // Only cache successful, non-empty responses of reasonable size. A redirect or error (e.g.
        // MI's login redirect for an asset while logged out) must not outlive the state that
        // produced it.
        if (
          res.statusCode === 200 &&
          responseSize > 0 &&
          responseSize < MAX_CACHED_ITEM_SIZE &&
          isStillSameIdentity(requestUser, sessionAtStart, users)
        ) {
          // Replaying a cached `Set-Cookie` would put the browser back on the session that was
          // current when the item was cached.
          const { 'set-cookie': _setCookie, ...headers } = res.getHeaders();

          const cacheItem: CacheItem = {
            headers,
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

      return (originalEnd as (...args: unknown[]) => ServerResponse).call(this, finalBuffer, callback);
    } as ServerResponse['end'];

    next();
  };
}

// Export cache instance for external access
export { cache };
