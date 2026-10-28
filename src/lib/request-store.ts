import { randomUUID } from 'node:crypto';

export const DEFAULT_MAX_MEMORY = 1 * 1024 * 1024 * 1024; // 1 GB

/**
 * Most requests kept, whatever their size: the inspector polls the list every 2 seconds, and a long
 * session of small requests stays far below {@link DEFAULT_MAX_MEMORY}.
 */
export const DEFAULT_MAX_ENTRIES = 10_000;

// Approximate per-entry overhead (headers, URL, metadata) so zero-body entries still count
// toward maxMemory and get evicted.
const ENTRY_OVERHEAD_BYTES = 512;

function entrySize(entry: RequestEntry): number {
  return (entry.requestBody?.byteLength ?? 0) + (entry.responseBody?.byteLength ?? 0) + ENTRY_OVERHEAD_BYTES;
}

function toMeta(e: RequestEntry): RequestMeta {
  return {
    id: e.id,
    timestamp: e.timestamp,
    method: e.method,
    url: e.url,
    statusCode: e.statusCode,
    duration: e.duration,
    source: e.source,
    user: e.user,
    requestSize: e.requestBody?.byteLength ?? 0,
    responseSize: e.responseBody?.byteLength ?? 0,
    requestBodyTruncated: e.requestBodyTruncated,
    responseBodyTruncated: e.responseBodyTruncated,
  };
}

export type RequestSource = 'local' | 'proxy' | 'proxy-cache';

export interface RequestEntry {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  statusCode: number | null;
  duration: number | null;
  source: RequestSource;
  /** The saved user the request was sent as; `undefined` for the original user. */
  user?: string;
  requestHeaders: Record<string, string | string[] | undefined>;
  requestBody: Buffer | null;
  requestBodyTruncated: boolean;
  responseHeaders: Record<string, number | string | string[] | undefined>;
  responseBody: Buffer | null;
  responseBodyTruncated: boolean;
}

export interface RequestMeta {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  statusCode: number | null;
  duration: number | null;
  source: RequestSource;
  user?: string;
  requestSize: number;
  responseSize: number;
  requestBodyTruncated: boolean;
  responseBodyTruncated: boolean;
}

export class RequestStore {
  private entries = new Map<string, RequestEntry>();
  /** Ids oldest first; the live ones start at {@link head}, so evicting is not an O(n) `shift()`. */
  private insertOrder: string[] = [];
  private head = 0;
  private totalSize = 0;
  readonly maxMemory: number;
  readonly maxEntries: number;

  constructor(maxMemory = DEFAULT_MAX_MEMORY, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxMemory = maxMemory;
    this.maxEntries = maxEntries;
  }

  private evictOldest(): void {
    const oldest = this.insertOrder[this.head++];
    const old = this.entries.get(oldest);

    if (old) {
      this.totalSize -= entrySize(old);
      this.entries.delete(oldest);
    }

    // Drop the evicted ids once they make up most of the array.
    if (this.head >= 1024 && this.head * 2 >= this.insertOrder.length) {
      this.insertOrder = this.insertOrder.slice(this.head);
      this.head = 0;
    }
  }

  allocateId(): string {
    return randomUUID();
  }

  add(entry: RequestEntry): void {
    let storedEntry = entry;
    let bodyBytes = (entry.requestBody?.byteLength ?? 0) + (entry.responseBody?.byteLength ?? 0);

    if (bodyBytes > this.maxMemory) {
      storedEntry = {
        ...entry,
        requestBody: null,
        responseBody: null,
        requestBodyTruncated: entry.requestBodyTruncated || entry.requestBody !== null,
        responseBodyTruncated: entry.responseBodyTruncated || entry.responseBody !== null,
      };
      bodyBytes = 0;
    }

    const size = entrySize(storedEntry);

    // Evict oldest entries until we have room
    while (
      (this.totalSize + size > this.maxMemory || this.entries.size >= this.maxEntries) &&
      this.head < this.insertOrder.length
    ) {
      this.evictOldest();
    }

    this.entries.set(storedEntry.id, storedEntry);
    this.insertOrder.push(storedEntry.id);
    this.totalSize += size;
  }

  get(id: string): RequestEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * The matching requests, oldest first: the most recent `limit` of them, or with an `offset`, `limit`
   * of them from the `offset`-th oldest. Only the entries returned are copied: the inspector polls
   * this every 2 seconds.
   */
  list(opts?: { limit?: number; offset?: number; method?: string; search?: string }): RequestMeta[] {
    const method = opts?.method?.toUpperCase();
    const search = opts?.search?.toLowerCase();
    const matches = (e: RequestEntry) =>
      (!method || e.method === method) && (!search || e.url.toLowerCase().includes(search));
    const limit = Number.isFinite(opts?.limit) ? opts!.limit! : Infinity;
    const result: RequestMeta[] = [];

    if (limit <= 0) {
      return result;
    }

    // Without an explicit offset, return the most recent `limit` entries (not the oldest).
    if (opts?.offset === undefined) {
      for (let i = this.insertOrder.length - 1; i >= this.head && result.length < limit; i -= 1) {
        const e = this.entries.get(this.insertOrder[i]);

        if (e && matches(e)) {
          result.push(toMeta(e));
        }
      }

      return result.reverse();
    }

    let skip = Number.isFinite(opts.offset) ? Math.max(0, opts.offset!) : 0;

    for (let i = this.head; i < this.insertOrder.length && result.length < limit; i += 1) {
      const e = this.entries.get(this.insertOrder[i]);

      if (!e || !matches(e)) {
        continue;
      }

      if (skip > 0) {
        skip -= 1;
      } else {
        result.push(toMeta(e));
      }
    }

    return result;
  }

  clear(): void {
    this.entries.clear();
    this.insertOrder = [];
    this.head = 0;
    this.totalSize = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get memoryUsage(): number {
    return this.totalSize;
  }
}
