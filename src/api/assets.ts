import { Axios } from 'axios';
import { Headers } from './constants.js';
import { BaseAPI } from './base.js';

export class AssetsAPI extends BaseAPI {
  // Import for CJS and ESM
  private formdataModulePromise = import('formdata-node');

  constructor(axios: Axios) {
    super(axios);
  }

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
    return this.axios
      .get<Buffer>(this.getDownloadUrl(appId), {
        withCredentials: true,
        headers: Object.assign({}, headers, { accept: '*/*' }),
        responseType: 'arraybuffer',
      })
      .then((res) => res.data);
  }

  /**
   * Upload page assets.
   * @param appId
   * @param file - Zip file with assets
   * @param headers
   */
  async uploadPageAssets(appId: number | string, file: Buffer, headers?: Headers) {
    const formData = new (await this.formdataModulePromise).FormData();
    const { File } = await this.formdataModulePromise;

    const assetFile = new File([file], 'file.zip', { type: 'application/zip' });

    formData.append('file', assetFile);

    const url = this.getUploadUrl(appId);

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
