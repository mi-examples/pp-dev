import axios, { Axios } from 'axios';
import { JSDOM } from 'jsdom';
import { AssetsAPI, PageAPI } from '../api/index.js';
import { Agent } from 'https';
import { createLogger } from './logger.js';
import { colors } from './helpers/color.helper.js';
import { Logger } from 'vite';

export type Headers = Record<string, string | undefined>;

export interface MiAPIOptions {
  portalPageId?: number;
  headers?: Headers;
  templateLess: boolean;
  disableSSLValidation?: boolean;
}

export const TEMPLATE_PAGE_NAME = '[DEV PAGE. DO NOT DELETE]';

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

  private logger: Logger;

  constructor(baseURL: string, opts?: MiAPIOptions) {
    const { headers = {}, portalPageId, templateLess = true, disableSSLValidation = false } = opts || {};

    this.#headers = headers;

    this.#pageVars = [];
    this.#pageTitle = '';

    this.#templateLoaded = Promise.resolve(false);

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

    this.logger = createLogger();
  }

  async isTemplateLoaded() {
    return this.#templateLoaded;
  }

  #clearHeaders(headers: Headers) {
    const obj = Object.assign({}, headers, { host: undefined, referer: undefined });

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
    if (!(await this.#templateLoaded) && !this.#pageTemplate) {
      this.#templateLoaded = new Promise((resolve) => {
        this.#templateLoadedResolve = resolve;
      });
    }

    if (this.#pageTemplate) {
      return Promise.resolve(this.#pageTemplate);
    }

    if (typeof this.templateLess === 'undefined') {
      this.templateLess = false;
    }

    const pageList = await this.pageApi
      .getAll(this.#clearHeaders(headers))
      .then((response) => {
        this.logger.info(colors.green('Page list fetched'));

        return response;
      })
      .catch(async (e) => {
        this.#templateLoadedResolve(false);

        if (await this.pageApi.checkAuth(this.#clearHeaders(headers))) {
          this.logger.error(colors.red(`Error fetching page list: ${e.message}\n${e.stack}`));

          throw new Error('Current user does not have access to page list');
        } else {
          throw e;
        }
      });

    let page = pageList.find((p) => p.name === TEMPLATE_PAGE_NAME);

    if (!page) {
      this.logger.warn(colors.yellow('Creating dev page template...'));

      page = await this.pageApi
        .create(
          {
            enabled: 'Y',
            name: TEMPLATE_PAGE_NAME,
            internal_name: 'dev-page-template',
            visible_in_homepage: 'Y',
          },
          this.#clearHeaders(headers),
        )
        .then((response) => {
          this.logger.info(colors.green('Dev page created'));

          return response;
        })
        .catch((e) => {
          this.logger.error(colors.red(`Error creating dev page: ${e.message}`));

          this.#templateLoadedResolve(false);

          throw new Error(
            `Error when creating dev page.
            That can be caused by missing permissions or page with name "${TEMPLATE_PAGE_NAME}" already exists`,
          );
        });
    }

    return await this.pageApi
      .getPageContent(page.internal_name, this.#clearHeaders(headers))
      .then((response) => {
        this.#pageTemplate = response;

        return response;
      })
      .then((response) => {
        this.#templateLoadedResolve(true);

        this.logger.info(colors.green('Page template fetched'));

        return response;
      })
      .catch((e) => {
        this.#templateLoadedResolve(false);

        this.logger.error(colors.red(`Error fetching page template: ${e.message}`));

        throw new Error('Error fetching page template');
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
        this.logger.error(colors.red(`Error fetching page variables: ${reason.message}`));

        if (reason.response?.status === 404) {
          throw new Error(`Portal Page with id "${pageId}" not found on instance ${this.#axios.getUri()}`);
        }

        if (reason.response?.status === 401) {
          throw new Error(
            `Current user does not have access to page with id "${pageId}" on instance ${this.#axios.getUri()}`,
          );
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
