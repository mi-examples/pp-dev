import axios, { Axios } from 'axios';
import { JSDOM } from 'jsdom';
import { AssetsAPI, PageAPI } from '../api/index.js';
import { Agent } from 'https';

export type Headers = Record<string, string | undefined>;

export interface MiAPIOptions {
  portalPageId?: number;
  headers?: Headers;
  templateLess: boolean;
  disableSSLValidation?: boolean;
}

export class MiAPI {
  #headers: Headers;

  #axios: Axios;

  #pageTemplate: string | null = null;

  #pageTitle!: string;

  #pageVars: { name: string; value: string }[];

  #templateLoaded: Promise<boolean>;
  #templateLoadedResolve!: (value: boolean) => void;

  private portalPageId?: number;
  private templateLess?: boolean;

  private assetsApi: AssetsAPI;
  private pageApi: PageAPI;

  constructor(baseURL: string, opts?: MiAPIOptions) {
    const { headers = {}, portalPageId, templateLess = true, disableSSLValidation = false } = opts || {};

    this.#headers = headers;

    this.#pageVars = [];
    this.#pageTitle = '';

    this.#templateLoaded = new Promise((resolve) => {
      this.#templateLoadedResolve = resolve;
    });

    if (disableSSLValidation) {
      axios.defaults.httpsAgent = new Agent({ rejectUnauthorized: false });
    }

    this.#axios = axios.create({
      baseURL,
      headers,
    });

    this.portalPageId = portalPageId;
    this.templateLess = templateLess;

    this.assetsApi = new AssetsAPI(this.#axios);
    this.pageApi = new PageAPI(this.#axios);
  }

  async isTemplateLoaded() {
    return this.#templateLoaded;
  }

  #clearHeaders(headers: Headers) {
    const obj = Object.assign({}, headers, { host: undefined });

    Object.keys(obj).forEach((key) => obj[key] === undefined && delete obj[key]);

    this.#headers = obj;

    return obj;
  }

  updateHeaders(headers: Headers) {
    this.#clearHeaders(headers);
  }

  /**
   * Get page template
   * @param headers
   */
  async getPageTemplate(headers: Headers) {
    if (this.#pageTemplate) {
      return Promise.resolve(this.#pageTemplate);
    }

    if (typeof this.templateLess === 'undefined') {
      this.templateLess = false;
    }

    const pageList = await this.pageApi.getAll(this.#clearHeaders(headers));

    let page = pageList.find((p) => p.name === '[DEV PAGE. DO NOT DELETE]');

    if (!page) {
      page = await this.pageApi.create(
        {
          enabled: 'Y',
          name: '[DEV PAGE. DO NOT DELETE]',
          internal_name: 'dev-page-template',
          visible_in_homepage: 'Y',
        },
        this.#clearHeaders(headers),
      );
    }

    return await this.pageApi
      .getPageContent(page.internal_name, this.#clearHeaders(headers))
      .then((response) => {
        this.#pageTemplate = response;

        return response;
      })
      .finally(() => {
        this.#templateLoadedResolve(true);
      });
  }

  /**
   * Get page template variables
   *
   * @param pageId
   * @param headers
   */
  async getPageVariables(pageId: number, headers: Headers) {
    this.#pageTemplate = await this.getPageTemplate(headers);

    if (!this.portalPageId) {
      this.portalPageId = pageId;
      this.templateLess = false;
    }

    return await this.pageApi
      .get(pageId, this.#clearHeaders(headers))
      .then((response) => {
        const { tags = '[]', name, template } = response;

        if (template && tags) {
          const parsed = JSON.parse(tags) as { name: string; value: string }[];

          this.#pageVars = parsed;
          this.#pageTitle = name;

          return parsed;
        }

        this.#pageVars = [];
        this.#pageTitle = name;

        return [];
      })
      .catch((reason) => {
        if (reason.response?.status === 404) {
          throw new Error(`Portal Page with id "${pageId}" not found on instance ${this.#axios.getUri()}`);
        }

        throw reason;
      });
  }

  /**
   * Build page with variables
   *
   * @param content
   * @param miHudLess
   */
  buildPage(content: string | Buffer, miHudLess = false) {
    let result = typeof content === 'string' ? content : content.toString('utf-8');

    for (const v of this.#pageVars) {
      result = result.replace(new RegExp(`\\[${v.name}\\]`, 'g'), v.value);
    }

    const dom = new JSDOM(miHudLess ? result : this.#pageTemplate!);

    const placeholderText = '%%PLACEHOLDER%%';

    if (!miHudLess) {
      const placeholder = dom.window.document.createElement('div');
      placeholder.innerHTML = placeholderText;

      const container = dom.window.document.querySelector('.main-side');

      if (container) {
        const scripts = container.querySelectorAll('script');

        if (scripts.length) {
          container.insertBefore(placeholder, scripts.item(scripts.length - 1));
        } else {
          container.append(placeholder);
        }

        const head = dom.window.document.querySelector('head')!;
        const title = head!.querySelector('title');

        if (title) {
          title.text = this.#pageTitle;
        } else {
          head.innerHTML += `<title>${this.#pageTitle}</title>`;
        }
      }
    }

    const serializedDom = dom.serialize();

    return serializedDom.replace(new RegExp(`<div>\\s*${placeholderText}\\s*<\\/div>`, 'i'), result);
  }

  async getAssets() {
    if (this.portalPageId) {
      if (this.templateLess) {
        return await this.assetsApi.downloadPageAssets(this.portalPageId, this.#headers);
      } else {
        const pageInfo = await this.pageApi.get(this.portalPageId, this.#headers);

        if (pageInfo.template) {
          return await this.assetsApi.downloadTemplateAssets(pageInfo.template, this.#headers);
        }
      }
    }
  }

  async updateAssets(assets: Buffer) {
    if (this.portalPageId) {
      if (this.templateLess) {
        return await this.assetsApi.uploadPageAssets(this.portalPageId, assets, this.#headers);
      } else {
        const pageInfo = await this.pageApi.get(this.portalPageId, this.#headers);

        if (pageInfo.template) {
          return await this.assetsApi.uploadTemplateAssets(pageInfo.template, assets, this.#headers);
        }
      }
    }
  }
}
