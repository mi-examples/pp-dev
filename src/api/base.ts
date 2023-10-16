import { Axios } from 'axios';

export class BaseAPI {
  protected axios: Axios;

  constructor(axios: Axios) {
    this.axios = axios;
  }
}
