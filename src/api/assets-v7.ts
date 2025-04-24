import { AssetsAPI } from './assets.js';

export class AssetsV7API extends AssetsAPI {
  protected getDownloadUrl(portalPageId: number | string) {
    return `/api/page/id/${portalPageId}/asset/download`;
  }

  protected getDownloadTemplateUrl(templateId: number | string) {
    return `/api/page_template/id/${templateId}/asset/download`;
  }

  protected getUploadUrl(portalPageId: number | string) {
    return `/api/page/id/${portalPageId}/asset/upload`;
  }

  protected getUploadTemplateUrl(templateId: number | string) {
    return `/api/page_template/id/${templateId}/asset/upload`;
  }
}
