import { BaseAPI } from './base.js';
import { Headers } from './constants.js';

export interface PageVariableTagEntry {
  name: string;
  value: string;
}

function isPageVariableTagEntry(value: unknown): value is PageVariableTagEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PageVariableTagEntry).name === 'string' &&
    typeof (value as PageVariableTagEntry).value === 'string'
  );
}

/**
 * `tags` may come back as a JSON string or an already-parsed array depending on backend
 * version. Reject the complete payload when any part is malformed: callers use the returned
 * array for full-replacement writes, so silently dropping entries could delete live values.
 */
export function normalizePageVariableTags(tags: unknown): PageVariableTagEntry[] {
  let parsed = tags;

  if (typeof tags === 'string') {
    try {
      parsed = JSON.parse(tags) as unknown;
    } catch {
      throw new TypeError('Page variable response contains invalid JSON in "tags".');
    }
  }

  if (!Array.isArray(parsed)) {
    throw new TypeError('Page variable response must contain a "tags" array.');
  }

  const malformedIndex = parsed.findIndex((entry) => !isPageVariableTagEntry(entry));

  if (malformedIndex !== -1) {
    throw new TypeError(`Page variable response contains a malformed entry at index ${malformedIndex}.`);
  }

  return parsed;
}

export class PageVariableAPI extends BaseAPI {
  /**
   * GET `/api/page_variable?page_id={pageId}`.
   * MI resolves the page via `PortalPage::loadById()` when `page_id` is a positive integer
   * (falls back to `internal_name` otherwise) — using `page_id` skips that fallback and the
   * extra page lookup a caller would otherwise need to resolve `internal_name` first.
   */
  async getById(pageId: number, headers?: Headers): Promise<PageVariableTagEntry[]> {
    const data = (
      await this.axios.get<{ tags: PageVariableTagEntry[] | string }>('/api/page_variable', {
        withCredentials: true,
        headers: Object.assign({}, headers, {
          accept: 'application/json',
          'content-type': 'application/json',
        }),
        params: {
          page_id: pageId,
        },
      })
    ).data;

    return normalizePageVariableTags(data?.tags);
  }

  /** PUT `/api/page_variable?page_id={pageId}` */
  async updateById(pageId: number, tags: PageVariableTagEntry[], headers?: Headers): Promise<void> {
    await this.axios.put(
      '/api/page_variable',
      { tags: JSON.stringify(tags) },
      {
        withCredentials: true,
        headers: Object.assign({}, headers, {
          accept: 'application/json',
          'content-type': 'application/json',
        }),
        params: {
          page_id: pageId,
        },
      },
    );
  }
}
