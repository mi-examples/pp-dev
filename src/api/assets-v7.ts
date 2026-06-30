import { AssetsAPI } from './assets.js';

export class AssetsV7API extends AssetsAPI {
  protected getDownloadUrl(appId: number | string) {
    return `/api/page/id/${appId}/asset/download`;
  }

  protected getDownloadTemplateUrl(templateId: number | string) {
    return `/api/page_template/id/${templateId}/asset/download`;
  }

  protected getUploadUrl(appId: number | string) {
    return `/api/page/id/${appId}/asset/upload`;
  }

  protected getUploadTemplateUrl(templateId: number | string) {
    return `/api/page_template/id/${templateId}/asset/upload`;
  }
}
