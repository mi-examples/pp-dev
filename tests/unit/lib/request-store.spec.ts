import { describe, it, expect } from 'vitest';
import { RequestStore, type RequestEntry } from '../../../src/lib/request-store.js';

/**
 * The request store behind the inspector. Its only limit was memory (1 GB), so a long session of
 * small requests grew without bound, and every 2-second poll of the list copied all of them.
 */

let next = 0;

function entry(overrides: Partial<RequestEntry> = {}): RequestEntry {
  next += 1;

  return {
    id: `r${next}`,
    timestamp: next,
    method: 'GET',
    url: `/api/${next}`,
    statusCode: 200,
    duration: 1,
    source: 'proxy',
    requestHeaders: {},
    requestBody: null,
    requestBodyTruncated: false,
    responseHeaders: {},
    responseBody: null,
    responseBodyTruncated: false,
    ...overrides,
  };
}

function fill(store: RequestStore, count: number, overrides: (i: number) => Partial<RequestEntry> = () => ({})) {
  const ids: string[] = [];

  for (let i = 0; i < count; i += 1) {
    const e = entry(overrides(i));

    store.add(e);
    ids.push(e.id);
  }

  return ids;
}

describe('RequestStore', () => {
  it('keeps at most maxEntries requests, dropping the oldest', () => {
    const store = new RequestStore(Infinity, 3);
    const ids = fill(store, 5);

    expect(store.size).toBe(3);
    expect(store.get(ids[1])).toBeUndefined();
    expect(store.list().map((e) => e.id)).toEqual(ids.slice(2));
  });

  it('still evicts by memory, and stays consistent across many evictions', () => {
    const store = new RequestStore(10 * 1024, 5_000);
    const ids = fill(store, 3_000, () => ({ responseBody: Buffer.alloc(1024) }));

    // 1536 bytes counted per entry: 6 fit in 10 KB.
    expect(store.size).toBe(6);
    expect(store.memoryUsage).toBe(6 * 1536);
    expect(store.list().map((e) => e.id)).toEqual(ids.slice(-6));
  });

  it('lists the most recent matching requests, oldest first', () => {
    const store = new RequestStore();
    const ids = fill(store, 10, (i) => ({ method: i % 2 ? 'POST' : 'GET' }));

    expect(store.list({ limit: 2, method: 'post' }).map((e) => e.id)).toEqual([ids[7], ids[9]]);
    expect(store.list({ limit: 3 }).map((e) => e.id)).toEqual(ids.slice(7));
    expect(store.list({ search: `/API/${ids[4].slice(1)}` }).map((e) => e.id)).toEqual([ids[4]]);
    expect(store.list({ limit: 0 })).toEqual([]);
  });

  it('pages from the oldest matching request with an offset', () => {
    const store = new RequestStore();
    const ids = fill(store, 10, (i) => ({ method: i % 2 ? 'POST' : 'GET' }));

    expect(store.list({ offset: 1, limit: 2, method: 'GET' }).map((e) => e.id)).toEqual([ids[2], ids[4]]);
    expect(store.list({ offset: 8 }).map((e) => e.id)).toEqual(ids.slice(8));
  });

  it('starts over after clear()', () => {
    const store = new RequestStore(Infinity, 2);

    fill(store, 5);
    store.clear();

    const ids = fill(store, 2);

    expect(store.size).toBe(2);
    expect(store.memoryUsage).toBe(2 * 512);
    expect(store.list().map((e) => e.id)).toEqual(ids);
  });
});
