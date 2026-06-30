import { randomUUID } from 'node:crypto';

export const DEFAULT_MAX_MEMORY = 1 * 1024 * 1024 * 1024; // 1 GB

export type RequestSource = 'local' | 'proxy' | 'proxy-cache';

export interface RequestEntry {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  statusCode: number | null;
  duration: number | null;
  source: RequestSource;
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
  requestSize: number;
  responseSize: number;
  requestBodyTruncated: boolean;
  responseBodyTruncated: boolean;
}

export class RequestStore {
  private entries = new Map<string, RequestEntry>();
  private insertOrder: string[] = [];
  private totalSize = 0;
  readonly maxMemory: number;

  constructor(maxMemory = DEFAULT_MAX_MEMORY) {
    this.maxMemory = maxMemory;
  }

  allocateId(): string {
    return randomUUID();
  }

  add(entry: RequestEntry): void {
    let storedEntry = entry;
    let size = (entry.requestBody?.byteLength ?? 0) + (entry.responseBody?.byteLength ?? 0);

    if (size > this.maxMemory) {
      storedEntry = {
        ...entry,
        requestBody: null,
        responseBody: null,
        requestBodyTruncated: entry.requestBodyTruncated || entry.requestBody !== null,
        responseBodyTruncated: entry.responseBodyTruncated || entry.responseBody !== null,
      };
      size = 0;
    }

    // Evict oldest entries until we have room
    while (this.totalSize + size > this.maxMemory && this.insertOrder.length > 0) {
      const oldest = this.insertOrder.shift()!;
      const old = this.entries.get(oldest);

      if (old) {
        this.totalSize -= (old.requestBody?.byteLength ?? 0) + (old.responseBody?.byteLength ?? 0);
        this.entries.delete(oldest);
      }
    }

    this.entries.set(storedEntry.id, storedEntry);
    this.insertOrder.push(storedEntry.id);
    this.totalSize += size;
  }

  get(id: string): RequestEntry | undefined {
    return this.entries.get(id);
  }

  list(opts?: { limit?: number; offset?: number; method?: string; search?: string }): RequestMeta[] {
    let result = this.insertOrder
      .slice()
      .map((id) => {
        const e = this.entries.get(id)!;

        return {
          id: e.id,
          timestamp: e.timestamp,
          method: e.method,
          url: e.url,
          statusCode: e.statusCode,
          duration: e.duration,
          source: e.source,
          requestSize: e.requestBody?.byteLength ?? 0,
          responseSize: e.responseBody?.byteLength ?? 0,
          requestBodyTruncated: e.requestBodyTruncated,
          responseBodyTruncated: e.responseBodyTruncated,
        };
      });

    if (opts?.method) {
      result = result.filter((e) => e.method === opts.method!.toUpperCase());
    }

    if (opts?.search) {
      const q = opts.search.toLowerCase();
      
      result = result.filter((e) => e.url.toLowerCase().includes(q));
    }

    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? result.length;

    return result.slice(offset, offset + limit);
  }

  clear(): void {
    this.entries.clear();
    this.insertOrder = [];
    this.totalSize = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get memoryUsage(): number {
    return this.totalSize;
  }
}
