import { Axios } from 'axios';
import { Headers } from './constants';

export class BaseAPI {
  protected axios: Axios;

  constructor(axios: Axios) {
    this.axios = axios;
  }

  async checkAuth(headers?: Headers) {
    return this.axios
      .get('/data/page/index/auth/info', {
        headers: Object.assign({}, headers, { accept: 'text/html' }),
        maxRedirects: 0,
      })
      .then(() => true)
      .catch(() => false);
  }
}
