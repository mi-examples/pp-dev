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

/** `tags` may come back as a JSON string or an already-parsed array depending on backend version. */
export function normalizePageVariableTags(tags: PageVariableTagEntry[] | string): PageVariableTagEntry[] {
  if (Array.isArray(tags)) {
    return tags.filter(isPageVariableTagEntry);
  }

  try {
    const parsed = JSON.parse(tags) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isPageVariableTagEntry);
  } catch {
    return [];
  }
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

    return normalizePageVariableTags(data?.tags ?? []);
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
