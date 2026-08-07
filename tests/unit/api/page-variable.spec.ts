import { describe, it, expect, vi } from 'vitest';
import { PageVariableAPI, normalizePageVariableTags } from '../../../src/api/page-variable.js';

function makeAxios(overrides: { get?: any; put?: any } = {}) {
  return {
    get: overrides.get ?? vi.fn(),
    put: overrides.put ?? vi.fn(),
  } as any;
}

describe('normalizePageVariableTags', () => {
  it('passes through a well-formed array', () => {
    const tags = [{ name: 'a', value: '1' }];

    expect(normalizePageVariableTags(tags)).toEqual(tags);
  });

  it('filters out malformed entries from an array', () => {
    const tags = [{ name: 'a', value: '1' }, { name: 'b' }, { value: '2' }, 'not-an-object'] as any;

    expect(normalizePageVariableTags(tags)).toEqual([{ name: 'a', value: '1' }]);
  });

  it('parses a JSON-stringified array', () => {
    expect(normalizePageVariableTags(JSON.stringify([{ name: 'a', value: '1' }]))).toEqual([
      { name: 'a', value: '1' },
    ]);
  });

  it('returns an empty array for invalid JSON or a non-array payload', () => {
    expect(normalizePageVariableTags('not json')).toEqual([]);
    expect(normalizePageVariableTags(JSON.stringify({ not: 'an array' }))).toEqual([]);
  });
});

describe('PageVariableAPI', () => {
  it('GETs /api/page_variable with page_id and normalizes the response', async () => {
    const get = vi.fn().mockResolvedValue({ data: { tags: [{ name: 'title', value: 'Hello' }] } });
    const api = new PageVariableAPI(makeAxios({ get }));

    const result = await api.getById(937);

    expect(get).toHaveBeenCalledWith('/api/page_variable', expect.objectContaining({ params: { page_id: 937 } }));
    expect(result).toEqual([{ name: 'title', value: 'Hello' }]);
  });

  it('normalizes a stringified tags response from GET', async () => {
    const get = vi.fn().mockResolvedValue({ data: { tags: JSON.stringify([{ name: 'title', value: 'Hello' }]) } });
    const api = new PageVariableAPI(makeAxios({ get }));

    const result = await api.getById(937);

    expect(result).toEqual([{ name: 'title', value: 'Hello' }]);
  });

  it('PUTs /api/page_variable with page_id param and JSON-stringified tags body', async () => {
    const put = vi.fn().mockResolvedValue({ data: {} });
    const api = new PageVariableAPI(makeAxios({ put }));

    await api.updateById(937, [{ name: 'title', value: 'Hello' }]);

    expect(put).toHaveBeenCalledWith(
      '/api/page_variable',
      { tags: JSON.stringify([{ name: 'title', value: 'Hello' }]) },
      expect.objectContaining({ params: { page_id: 937 } }),
    );
  });
});
