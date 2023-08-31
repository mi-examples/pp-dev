import { Axios } from 'axios';
import { Headers } from './constants.js';
import { FormData, File } from 'formdata-node';

export class AssetsAPI {
  private axios: Axios;

  constructor(axios: Axios) {
    this.axios = axios;
  }

  async downloadPageAssets(portalPageId: number | string, headers?: Headers) {
    return this.axios
      .get<Buffer>(`/admin/page/downloadassets/id/${portalPageId}`, {
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
    const formData = new FormData();

    const assetFile = new File([file.buffer], 'file.zip', { type: 'application/zip' });

    formData.append('file', assetFile);

    const url = `/admin/page/uploadassets/id/${portalPageId}`;

    return this.axios
      .post<{ status?: 'OK' }>(`/admin/page/uploadassets/id/${portalPageId}`, formData, {
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
      .get<Buffer>(`/admin/pagetemplate/downloadassets/id/${templateId}`, {
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
    const formData = new FormData();

    const assetFile = new File([file.buffer], 'file.zip', { type: 'application/zip' });

    formData.append('file', assetFile, 'file.zip');

    const url = `/admin/pagetemplate/uploadassets/id/${templateId}`;

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
