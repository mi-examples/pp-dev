import { describe, it, expect, vi } from 'vitest';
import { MiAPI } from '../../../src/lib/pp.middleware.js';

/**
 * The dev panel's own MI calls (the sync's asset download and upload, the credentials check) went
 * with the headers MiAPI was made with, to which only a page data load added the personal access
 * token. A dev server restarted in process serves the page from the load the previous MiAPI made,
 * so the new one never loaded, and a sync right after the restart reached MI with no token at all:
 * "Authentication error" with a working token.
 */
function makeMi() {
  const mi = new MiAPI('http://mi.example.com', {
    templateLess: true,
    appId: 7,
    personalAccessToken: 'DEV-PAT',
    headers: { host: 'mi.example.com', referer: 'http://mi.example.com', origin: 'http://mi.example.com' },
  });

  return mi;
}

function headersOf(call: unknown[] | undefined): Record<string, unknown> {
  return (call?.at(-1) ?? {}) as Record<string, unknown>;
}

describe('MiAPI — the token on its own MI calls before any page data load', () => {
  it('downloads the assets with the personal access token', async () => {
    const mi = makeMi();
    const download = vi.spyOn(mi['assetsApi'], 'downloadPageAssets').mockResolvedValue(Buffer.alloc(0) as never);

    await mi.getAssets();

    expect(headersOf(download.mock.calls[0])).toMatchObject({ authorization: 'Bearer DEV-PAT' });
  });

  it('uploads the assets with the personal access token', async () => {
    const mi = makeMi();
    const upload = vi.spyOn(mi['assetsApi'], 'uploadPageAssets').mockResolvedValue({ status: 'OK' } as never);

    await mi.updateAssets(Buffer.from('zip'));

    expect(headersOf(upload.mock.calls[0])).toMatchObject({ authorization: 'Bearer DEV-PAT' });
  });

  it('checks the credentials with the personal access token', async () => {
    const mi = makeMi();
    const get = vi.spyOn(mi, 'get').mockResolvedValue({ data: {} } as never);

    await expect(mi.validateCredentials()).resolves.toEqual({ isValid: true });

    expect(get).toHaveBeenCalledWith('/api/user', expect.objectContaining({ authorization: 'Bearer DEV-PAT' }), true);
  });

  it('leaves the host and referer of the page it was made for out, as a page load does', async () => {
    const mi = makeMi();
    const download = vi.spyOn(mi['assetsApi'], 'downloadPageAssets').mockResolvedValue(Buffer.alloc(0) as never);

    await mi.getAssets();

    const headers = headersOf(download.mock.calls[0]);

    expect(headers).not.toHaveProperty('host');
    expect(headers).not.toHaveProperty('referer');
    expect(headers).toMatchObject({ origin: 'http://mi.example.com' });
  });

  it('keeps the headers a page data load stored', async () => {
    const mi = makeMi();

    vi.spyOn(mi['pageApi'], 'get').mockResolvedValue({ name: 'Sales', template: 'tpl', tags: '[]' } as never);
    vi.spyOn(mi, 'getPageTemplate').mockResolvedValue('<html></html>' as never);
    await mi.getPageVariables(7, { cookie: 'session=abc', host: 'localhost:3000' });

    const download = vi.spyOn(mi['assetsApi'], 'downloadPageAssets').mockResolvedValue(Buffer.alloc(0) as never);

    await mi.getAssets();

    expect(headersOf(download.mock.calls[0])).toMatchObject({ cookie: 'session=abc', authorization: 'Bearer DEV-PAT' });
    expect(headersOf(download.mock.calls[0])).not.toHaveProperty('host');
  });
});
