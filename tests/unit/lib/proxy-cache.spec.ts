import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProxyCache } from '../../../src/lib/proxy-cache.middleware';

const item = (size: number) => ({ size });

describe('ProxyCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns stored items until their TTL expires', () => {
    const cache = new ProxyCache(1000, 10);
    const value = item(10);

    cache.put('a', value, 1000);
    expect(cache.get('a')).toBe(value);

    vi.advanceTimersByTime(999);
    expect(cache.get('a')).toBe(value);

    vi.advanceTimersByTime(1);
    expect(cache.get('a')).toBeNull();
    expect(cache.getTotalSize()).toBe(0);
  });

  it('returns null for missing keys', () => {
    expect(new ProxyCache(1000, 10).get('missing')).toBeNull();
  });

  it('evicts the oldest items past maxItems', () => {
    const cache = new ProxyCache(1000, 2);

    cache.put('a', item(1), 1000);
    cache.put('b', item(1), 1000);
    cache.put('c', item(1), 1000);

    expect(cache.keys()).toEqual(['b', 'c']);
    expect(cache.getTotalSize()).toBe(2);
  });

  it('evicts the oldest items past maxSize', () => {
    const cache = new ProxyCache(25, 100);

    cache.put('a', item(10), 1000);
    cache.put('b', item(10), 1000);
    cache.put('c', item(10), 1000);

    expect(cache.keys()).toEqual(['b', 'c']);
    expect(cache.getTotalSize()).toBe(20);
  });

  it('treats a re-put as the newest write and keeps size accounting exact', () => {
    const cache = new ProxyCache(1000, 2);

    cache.put('a', item(5), 1000);
    cache.put('b', item(5), 1000);
    cache.put('a', item(7), 1000);
    cache.put('c', item(1), 1000);

    expect(cache.keys()).toEqual(['a', 'c']);
    expect(cache.getTotalSize()).toBe(8);
  });

  it('drops expired items when writing, so they do not count against the limits', () => {
    const cache = new ProxyCache(1000, 2);

    cache.put('old', item(1), 100);
    vi.advanceTimersByTime(100);
    cache.put('b', item(1), 1000);
    cache.put('c', item(1), 1000);

    expect(cache.keys()).toEqual(['b', 'c']);
  });

  it('del removes an item and its size', () => {
    const cache = new ProxyCache(1000, 10);

    cache.put('a', item(10), 1000);

    expect(cache.del('a')).toBe(true);
    expect(cache.del('a')).toBe(false);
    expect(cache.getTotalSize()).toBe(0);
  });

  it('clear resets items and total size', () => {
    const cache = new ProxyCache(1000, 10);

    cache.put('a', item(10), 1000);
    cache.put('b', item(10), 1000);
    cache.clear();

    expect(cache.getItemCount()).toBe(0);
    expect(cache.getTotalSize()).toBe(0);
  });
});
