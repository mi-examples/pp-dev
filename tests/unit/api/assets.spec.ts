import { describe, it, expect, vi } from 'vitest';
import { AssetsAPI } from '../../../src/api/assets.js';
import { AssetsV7API } from '../../../src/api/assets-v7.js';

/** Page and template assets go through one download and one upload, each with its own URLs. */

function makeAxios() {
  return {
    get: vi.fn().mockResolvedValue({ data: Buffer.from('zip') }),
    post: vi.fn().mockResolvedValue({ data: { status: 'OK' } }),
    getUri: vi.fn(({ url }: { url: string }) => `https://mi.example.com${url}`),
  };
}

describe.each([
  [
    'AssetsAPI',
    AssetsAPI,
    {
      page: ['/admin/page/downloadassets/id/7', '/admin/page/uploadassets/id/7'],
      template: ['/admin/pagetemplate/downloadassets/id/9', '/admin/pagetemplate/uploadassets/id/9'],
    },
  ],
  [
    'AssetsV7API',
    AssetsV7API,
    {
      page: ['/api/page/id/7/asset/download', '/api/page/id/7/asset/upload'],
      template: ['/api/page_template/id/9/asset/download', '/api/page_template/id/9/asset/upload'],
    },
  ],
])('%s', (_name, Api, urls) => {
  it('downloads page and template assets as binary', async () => {
    const axios = makeAxios();
    const api = new Api(axios as never);

    expect(await api.downloadPageAssets(7, { cookie: 'c' })).toEqual(Buffer.from('zip'));
    expect(await api.downloadTemplateAssets(9)).toEqual(Buffer.from('zip'));

    expect(axios.get.mock.calls.map(([url]) => url)).toEqual([urls.page[0], urls.template[0]]);
    expect(axios.get).toHaveBeenCalledWith(
      urls.page[0],
      expect.objectContaining({ responseType: 'arraybuffer', headers: { cookie: 'c', accept: '*/*' } }),
    );
  });

  it.each([
    ['page', (api: AssetsAPI, file: Buffer) => api.uploadPageAssets(7, file), 'page'],
    ['template', (api: AssetsAPI, file: Buffer) => api.uploadTemplateAssets(9, file), 'template'],
  ] as const)('uploads %s assets as file.zip in a multipart form', async (_kind, upload, key) => {
    const axios = makeAxios();
    const api = new Api(axios as never);

    expect(await upload(api, Buffer.from('zip-bytes'))).toEqual({ status: 'OK' });

    const [url, form, config] = axios.post.mock.calls[0];
    const file = (form as FormData).get('file') as File;

    expect(url).toBe(urls[key][1]);
    expect(file.name).toBe('file.zip');
    expect(file.type).toBe('application/zip');
    expect(Buffer.from(await file.arrayBuffer()).toString()).toBe('zip-bytes');
    expect(config.headers).toMatchObject({
      'Content-Type': 'multipart/form-data',
      Referer: `https://mi.example.com${urls[key][1]}`,
    });
  });
});
