import axios, { Axios } from 'axios';
import { JSDOM } from 'jsdom';

export type Headers = Record<string, string | undefined>;

export class MiAPI {
  #headers: Headers;

  #axios: Axios;

  #pageTemplate: string | null = null;

  #pageTitle!: string;

  #pageVars: { name: string; value: string }[];

  #templateLoaded: Promise<boolean>;
  #templateLoadedResolve!: (value: boolean) => void;

  constructor(baseURL: string, opts?: { headers?: Headers }) {
    const { headers = {} } = opts || {};

    this.#headers = headers;

    this.#pageVars = [];

    this.#templateLoaded = new Promise((resolve) => {
      this.#templateLoadedResolve = resolve;
    });

    this.#axios = axios.create({ baseURL, headers });
  }

  async isTemplateLoaded() {
    return this.#templateLoaded;
  }

  #clearHeaders(headers: Headers) {
    const obj = Object.assign({}, headers, { host: undefined });

    Object.keys(obj).forEach(
      (key) => obj[key] === undefined && delete obj[key],
    );

    return obj;
  }

  async getPageTemplate(headers: Headers) {
    if (this.#pageTemplate) {
      return Promise.resolve(this.#pageTemplate);
    }

    const pageList = await this.#axios
      .get<{ pages: { name: string; internal_name: string }[] }>('/api/page', {
        withCredentials: true,
        headers: Object.assign(this.#clearHeaders(headers), {
          accept: 'application/json',
          'content-type': 'application/json',
        }),
      })
      .then((response) => response.data);

    let page = pageList.pages.find(
      (p) => p.name === '[DEV PAGE. DO NOT DELETE]',
    );

    if (!page) {
      page = await this.#axios
        .post<{ page: { name: string; internal_name: string } }>(
          '/api/page/',
          {
            enabled: 'Y',
            name: '[DEV PAGE. DO NOT DELETE]',
            internal_name: 'dev-page-template',
            visible_in_homepage: 'Y',
          },
          {
            withCredentials: true,
            headers: Object.assign(this.#clearHeaders(headers), {
              accept: 'application/json',
              'content-type': 'application/json',
            }),
          },
        )
        .then((response) => response.data.page);
    }

    return await this.#axios
      .get<string>(`/p/${page!.internal_name}`, {
        withCredentials: true,
        headers: Object.assign(this.#clearHeaders(headers), {
          accept: 'text/html',
          'content-type': 'application/json',
        }),
      })
      .then((response) => response.data)
      .finally(() => {
        this.#templateLoadedResolve(true);
      });
  }

  async getPageVariables(pageId: number, headers: Headers) {
    this.#pageTemplate = await this.getPageTemplate(headers);

    return await this.#axios
      .get<{ page: { name: string; tags: string; template?: string } }>(
        `/api/page/id/${pageId}`,
        {
          withCredentials: true,
          headers: Object.assign(this.#clearHeaders(headers), {
            accept: 'application/json',
            'content-type': 'application/json',
          }),
        },
      )
      .then((response) => {
        const {
          page: { tags, name, template },
        } = response.data;

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
          throw new Error(
            `Portal Page with id "${pageId}" not found on instance ${this.#axios.getUri()}`,
          );
        }

        throw reason;
      });
  }

  buildPage(content: string | Buffer, miHudLess = false) {
    let result =
      typeof content === 'string' ? content : content.toString('utf-8');

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

    return serializedDom.replace(
      new RegExp(`<div>\\s*${placeholderText}\\s*<\\/div>`, 'i'),
      result,
    );
  }
}
