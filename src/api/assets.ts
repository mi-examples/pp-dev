import { Axios } from 'axios';
import { Headers } from './constants.js';
import { BaseAPI } from './base.js';

export class AssetsAPI extends BaseAPI {
  // Import for CJS and ESM
  private formdataModulePromise = import('formdata-node');

  constructor(axios: Axios) {
    super(axios);
  }

  protected getDownloadUrl(portalPageId: number | string) {
    return `/admin/page/downloadassets/id/${portalPageId}`;
  }

  protected getDownloadTemplateUrl(templateId: number | string) {
    return `/admin/pagetemplate/downloadassets/id/${templateId}`;
  }

  protected getUploadUrl(portalPageId: number | string) {
    return `/admin/page/uploadassets/id/${portalPageId}`;
  }

  protected getUploadTemplateUrl(templateId: number | string) {
    return `/admin/pagetemplate/uploadassets/id/${templateId}`;
  }

  async downloadPageAssets(portalPageId: number | string, headers?: Headers) {
    return this.axios
      .get<Buffer>(this.getDownloadUrl(portalPageId), {
        withCredentials: true,
        headers: Object.assign({}, headers, { accept: '*/*' }),
        responseType: 'arraybuffer',
      })
      .then((res) => res.data);
  }

  /**
   * Upload page assets.
   * @param portalPageId
   * @param file - Zip file with assets
   * @param headers
   */
  async uploadPageAssets(portalPageId: number | string, file: Buffer, headers?: Headers) {
    const formData = new (await this.formdataModulePromise).FormData();
    const { File } = await this.formdataModulePromise;

    const assetFile = new File([file], 'file.zip', { type: 'application/zip' });

    formData.append('file', assetFile);

    const url = this.getUploadUrl(portalPageId);

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

  async downloadTemplateAssets(templateId: number | string, headers?: Headers) {
    return this.axios
      .get<Buffer>(this.getDownloadTemplateUrl(templateId), {
        withCredentials: true,
        headers: Object.assign({}, headers, { accept: '*/*' }),
        responseType: 'arraybuffer',
      })
      .then((res) => res.data);
  }

  /**
   * Upload template assets.
   * @param templateId
   * @param file - Zip file with assets
   * @param headers
   */
  async uploadTemplateAssets(templateId: number | string, file: Buffer, headers?: Headers) {
    const formData = new (await this.formdataModulePromise).FormData();
    const { File } = await this.formdataModulePromise;

    const assetFile = new File([file], 'file.zip', { type: 'application/zip' });

    formData.append('file', assetFile, 'file.zip');

    const url = this.getUploadTemplateUrl(templateId);

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

