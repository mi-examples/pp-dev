import { Headers } from './constants.js';
import { BaseAPI } from './base.js';

export class AssetsAPI extends BaseAPI {
  protected getDownloadUrl(appId: number | string) {
    return `/admin/page/downloadassets/id/${appId}`;
  }

  protected getDownloadTemplateUrl(templateId: number | string) {
    return `/admin/pagetemplate/downloadassets/id/${templateId}`;
  }

  protected getUploadUrl(appId: number | string) {
    return `/admin/page/uploadassets/id/${appId}`;
  }

  protected getUploadTemplateUrl(templateId: number | string) {
    return `/admin/pagetemplate/uploadassets/id/${templateId}`;
  }

  async downloadPageAssets(appId: number | string, headers?: Headers) {
    return this.download(this.getDownloadUrl(appId), headers);
  }

  /**
   * Upload page assets.
   * @param appId
   * @param file - Zip file with assets
   * @param headers
   */
  async uploadPageAssets(appId: number | string, file: Buffer, headers?: Headers) {
    return this.upload(this.getUploadUrl(appId), file, headers);
  }

  async downloadTemplateAssets(templateId: number | string, headers?: Headers) {
    return this.download(this.getDownloadTemplateUrl(templateId), headers);
  }

  /**
   * Upload template assets.
   * @param templateId
   * @param file - Zip file with assets
   * @param headers
   */
  async uploadTemplateAssets(templateId: number | string, file: Buffer, headers?: Headers) {
    return this.upload(this.getUploadTemplateUrl(templateId), file, headers);
  }

  private async download(url: string, headers?: Headers) {
    return this.axios
      .get<Buffer>(url, {
        withCredentials: true,
        headers: Object.assign({}, headers, { accept: '*/*' }),
        responseType: 'arraybuffer',
      })
      .then((res) => res.data);
  }

  /** Sends {@link file}, a zip of assets, as the `file` field of a multipart form. */
  private async upload(url: string, file: Buffer, headers?: Headers) {
    const formData = new FormData();

    formData.append('file', new File([new Uint8Array(file)], 'file.zip', { type: 'application/zip' }), 'file.zip');

    return this.axios
      .post<{ status?: 'OK' }>(url, formData, {
        withCredentials: true,
        headers: Object.assign({}, headers, {
          accept: 'application/json',
          'Content-Type': 'multipart/form-data',
          Referer: this.axios.getUri({ url }),
        }),
      })
      .then((res) => res.data);
  }
}
