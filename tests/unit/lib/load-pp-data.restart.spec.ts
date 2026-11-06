import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { initLoadPPData, clearAPICache } from '../../../src/lib/load-pp-data.middleware.js';
import { authProvider } from '../../../src/lib/auth.provider.js';
import { invalidateProxyCache } from '../../../src/lib/proxy-cache.middleware.js';
import type { MiAPI } from '../../../src/lib/pp.middleware.js';

/**
 * The page data cache was one for the module, so after a dev server restarted in process (`pp-dev`
 * on a config change, Vite's own restart) the new chain's MiAPI never loaded: the page came from
 * the cache the old one filled, built with no template and no variables, and the sync went to MI
 * without the headers a load stores.
 */
function makeMi() {
  return {
    getPageTemplate: vi.fn().mockResolvedValue('<html></html>'),
    getPageVariables: vi.fn().mockResolvedValue([]),
    getPageInfo: vi.fn().mockResolvedValue({}),
  } as unknown as MiAPI;
}

function makeRes() {
  return { statusCode: 200, headersSent: false, writableEnded: false, setHeader: vi.fn(), end: vi.fn() };
}

const pageRequest = () => ({ url: '/', headers: { accept: 'text/html', 'sec-fetch-dest': 'document' } }) as never;

async function load(mi: MiAPI, opts: Record<string, unknown> = {}) {
  const middleware = initLoadPPData(/^\/$/, mi, opts);
  const next = vi.fn();

  await middleware(pageRequest(), makeRes() as unknown as ServerResponse, next);

  return next;
}

describe('load-pp-data middleware — the page data cache across a dev server restart', () => {
  beforeEach(() => {
    authProvider.reset();
    clearAPICache();
  });

  it('serves the same MiAPI from its cache', async () => {
    const mi = makeMi();

    await load(mi);
    await load(mi);

    expect(mi.getPageTemplate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['page data', {}],
    ['page info', { templateLess: true, miHudLess: true, appId: 1 }],
  ])("loads the %s for a new MiAPI, whatever the old one's cache holds", async (_name, opts) => {
    const before = makeMi();
    const after = makeMi();

    await load(before, opts);
    const next = await load(after, opts);

    const call = (opts as { appId?: number }).appId ? 'getPageInfo' : 'getPageTemplate';

    expect(after[call]).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('forgets every load on clearAPICache()', async () => {
    const mi = makeMi();

    await load(mi);
    clearAPICache();
    await load(mi);

    expect(mi.getPageTemplate).toHaveBeenCalledTimes(2);
  });

  it('forgets every load when the proxy cache is invalidated', async () => {
    const mi = makeMi();

    await load(mi);
    invalidateProxyCache('a user switched');
    await load(mi);

    expect(mi.getPageTemplate).toHaveBeenCalledTimes(2);
  });
});
