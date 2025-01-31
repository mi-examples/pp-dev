import { BaseAPI } from './base';
import { Headers } from './constants';

export interface PageTemplate {
  id: number;
  name: string;
  internal_name: string;
  enabled: 'Y' | 'N';
  sync_with_git: 'Y' | 'N';
  visible_in_homepage: 'Y' | 'N';
  display_without_nav_bar: 'Y' | 'N';
}

export interface PageTemplateExtended extends PageTemplate {
  can_edit: 'Y' | 'N';
  version_identifier: string;
}

export class PageTemplateAPI extends BaseAPI {
  public async getAll(internal_name?: string, headers?: Headers) {
    return (
      await this.axios.get<{ page_templates: PageTemplate[] }>(`/api/page_template`, {
        withCredentials: true,
        headers: Object.assign({}, headers, {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          Expires: '0',
        }),
        params: {
          internal_name,
        },
      })
    ).data.page_templates;
  }

  public async get(id: number, headers?: Headers) {
    return (
      await this.axios.get<{ page_template: PageTemplateExtended }>(`/api/page_template/id/${id}`, {
        withCredentials: true,
        headers: Object.assign({}, headers, {
          accept: 'application/json',
          'content-type': 'application/json',
        }),
      })
    ).data.page_template;
  }
}
