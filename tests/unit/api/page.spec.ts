import { describe, it, expect, vi } from 'vitest';
import { PageAPI } from '../../../src/api/page.js';
import { PageVariableAPI } from '../../../src/api/page-variable.js';
import { isUnavailableJsonApiError } from '../../../src/api/unavailable-json-api.js';

/**
 * MI answers with its HTML maintenance page and a 200 while it is down. Read as JSON, that reached
 * the variables editor and the page-list code as "Cannot read properties of undefined"; it now
 * fails with the "instance may be down" error the rest of the page data already uses.
 */

const MAINTENANCE_PAGE = '<!DOCTYPE html><html><body>Down for maintenance</body></html>';

function makeAxios(data: unknown) {
  return {
    get: vi.fn().mockResolvedValue({ data }),
    post: vi.fn().mockResolvedValue({ data }),
  } as never;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

describe('PageAPI — responses that are not the JSON asked for', () => {
  const page = { id: 1, name: 'Sales', internal_name: 'sales', enabled: 'Y', visible_in_homepage: 'Y' };

  it.each([[MAINTENANCE_PAGE], [null], [{}], [{ pages: 'x' }]])('getAll() fails as unavailable on %j', async (data) => {
    expect(isUnavailableJsonApiError(await rejection(new PageAPI(makeAxios(data)).getAll()))).toBe(true);
  });

  it.each([[MAINTENANCE_PAGE], [null], [{}], [{ page: null }]])('get() fails as unavailable on %j', async (data) => {
    expect(isUnavailableJsonApiError(await rejection(new PageAPI(makeAxios(data)).get(1)))).toBe(true);
  });

  it.each([[MAINTENANCE_PAGE], [{}]])('create() fails as unavailable on %j', async (data) => {
    const { id: _id, ...newPage } = page;

    expect(isUnavailableJsonApiError(await rejection(new PageAPI(makeAxios(data)).create(newPage as never)))).toBe(
      true,
    );
  });

  it('returns the page data of a JSON answer', async () => {
    expect(await new PageAPI(makeAxios({ pages: [page] })).getAll()).toEqual([page]);
    expect(await new PageAPI(makeAxios({ page })).get(1)).toEqual(page);
    expect(await new PageAPI(makeAxios({ page })).create(page as never)).toEqual(page);
  });
});

describe('PageVariableAPI — responses that are not the JSON asked for', () => {
  it.each([[MAINTENANCE_PAGE], [null], ['']])('getById() fails as unavailable on %j', async (data) => {
    expect(isUnavailableJsonApiError(await rejection(new PageVariableAPI(makeAxios(data)).getById(1)))).toBe(true);
  });

  it('still says what is wrong with a JSON answer of the wrong shape', async () => {
    const error = await rejection(new PageVariableAPI(makeAxios({ tags: 'not json' })).getById(1));

    expect(isUnavailableJsonApiError(error)).toBe(false);
    expect((error as Error).message).toContain('invalid JSON');
  });
});
