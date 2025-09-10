import axios, { Axios } from "axios";
import { JSDOM } from "jsdom";
import {
  AssetsAPI,
  PageAPI,
  AssetsV7API,
  PageTemplateAPI,
} from "../api/index.js";
import { Agent } from "https";
import { createLogger } from "./logger.js";
import { colors, getTokenErrorInfo, logTokenError } from "./helpers/index.js";
import { Logger } from "vite";

export type Headers = Record<string, string | undefined>;

export interface MiAPIOptions {
  portalPageId?: number;
  headers?: Headers;
  templateLess: boolean;
  disableSSLValidation?: boolean;
  v7Features?: boolean;
  personalAccessToken?: string;
}

export const TEMPLATE_PAGE_NAME = "[DEV PAGE. DO NOT DELETE]";

// Performance optimization: Connection pool for axios instances
const axiosInstanceCache = new Map<string, Axios>();

// Performance optimization: Lazy JSDOM import
let jsdomModule: typeof import("jsdom") | null = null;

async function getJSDOM() {
  if (!jsdomModule) {
    jsdomModule = await import("jsdom");
  }
  return jsdomModule;
}

export class MiAPI {
  #headers: Headers;

  readonly #axios: Axios;

  #pageTemplate: string | null = null;

  #pageTitle!: string;

  #pageVars: { name: string; value: string }[];

  #v7Features!: boolean;

  #personalAccessToken!: string | undefined;

  #isV710OrHigher!: boolean;

  #templateLoaded: Promise<boolean>;
  #templateLoadedResolve!: (value: boolean) => void;

  private portalPageId?: number;
  private templateLess?: boolean;

  private assetsApi: AssetsAPI;
  private pageApi: PageAPI;
  private pageTemplateApi: PageTemplateAPI;

  private logger: Logger;

  constructor(baseURL: string, opts?: MiAPIOptions) {
    const {
      headers = {},
      portalPageId,
      templateLess = true,
      disableSSLValidation = false,
      v7Features = false,
      personalAccessToken,
    } = opts || {};

    this.#headers = headers;

    this.#pageVars = [];
    this.#pageTitle = "";

    this.#v7Features = v7Features;
    this.#personalAccessToken = personalAccessToken;
    this.#isV710OrHigher = false;

    this.#templateLoaded = Promise.resolve(false);

    // Performance optimization: Use cached axios instance
    const cacheKey = `${baseURL}:${disableSSLValidation}`;
    if (axiosInstanceCache.has(cacheKey)) {
      this.#axios = axiosInstanceCache.get(cacheKey)!;
    } else {
      if (disableSSLValidation) {
        axios.defaults.httpsAgent = new Agent({ rejectUnauthorized: false });
      }

      this.#axios = axios.create({
        baseURL,
        headers,
        // Performance optimization: Add connection pooling
        timeout: 30000, // 30 seconds timeout
        maxRedirects: 5,
        // Keep connections alive
        httpAgent: new Agent({ keepAlive: true, maxSockets: 10 }),
        httpsAgent: new Agent({ keepAlive: true, maxSockets: 10 }),
      });

      axiosInstanceCache.set(cacheKey, this.#axios);
    }

    this.portalPageId = portalPageId;
    this.templateLess = templateLess;

    this.assetsApi = new (!v7Features ? AssetsAPI : AssetsV7API)(this.#axios);
    this.pageApi = new PageAPI(this.#axios);
    this.pageTemplateApi = new PageTemplateAPI(this.#axios);

    this.logger = createLogger();
  }

  async isTemplateLoaded() {
    return this.#templateLoaded;
  }

  get isV710OrHigher() {
    return this.#isV710OrHigher;
  }

  #clearHeaders(headers: Headers) {
    const obj = Object.assign({}, headers, {
      host: undefined,
      referer: undefined,
    });

    Object.keys(obj).forEach(
      (key) => obj[key] === undefined && delete obj[key]
    );

    this.#headers = obj;

    if (!obj.authorization && this.#personalAccessToken) {
      obj.authorization = `Bearer ${this.#personalAccessToken}`;
    }

    return obj;
  }

  get personalAccessToken(): string | undefined {
    return this.#personalAccessToken;
  }

  set personalAccessToken(token: string | undefined) {
    this.#personalAccessToken = token;
  }

  updateHeaders(headers: Headers) {
    this.#clearHeaders(headers);
  }

  private get localTemplateHTML() {
    return /* HTML */ `<!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <title>%%PAGE TITLE%%</title>
          <meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/>
          <meta name="theme-color" content="rgba(255, 255, 255, 1)"/>
          <link rel="shortcut icon" type="image/x-icon" sizes="any" href="/img/favicon/favicon.ico"/>
          <link rel="icon" type="image/png" sizes="16x16" href="/img/favicon/favicon-16x16.png"/>
          <link rel="icon" type="image/png" sizes="32x32" href="/img/favicon/favicon-32x32.png"/>
          <link rel="icon" type="image/png" sizes="48x48" href="/img/favicon/favicon-48x48.png"/>
          <meta name="msapplication-config" content="/auth/browserconfig.xml"/>
          <link rel="apple-touch-icon" sizes="180x180" href="/img/favicon/apple-touch-icon.png"/>
          <link rel="manifest" href="/auth/site.webmanifest"/>
          <link rel="manifest" href="/auth/manifest.json"/>
          <link rel="stylesheet" type="text/css" href="/auth/theme-vars.css"/>
          <link rel="icon" type="image/svg+xml" href="/favicon.ico" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <script src="/js/libs/underscore-latest.min.js" charset="utf-8"></script>
          <script src="/js/jquery/jquery-latest.min.js" charset="utf-8"></script>
          <script src="/js/application/rating_component.js" charset="utf-8"></script>
        </head>
        <body>
          <div id="mi-react-root"></div>
          <script src="/auth/info.js"></script>
          <script src="/js/main.js" defer></script>
          <link rel="stylesheet" href="/css/main.css" />
        </body>
      </html>` as const;
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

    if (typeof this.templateLess === "undefined") {
      this.templateLess = false;
    }

    if (this.#v7Features) {
      const page = await this.pageApi
        .get(this.portalPageId!, this.#clearHeaders(headers))
        .then((response) => {
          this.logger.info(colors.green("Page fetched"));

          return response;
        })
        .catch(async (e) => {
          this.#templateLoadedResolve(false);

          if (await this.pageApi.checkAuth(this.#clearHeaders(headers))) {
            this.logger.error(
              colors.red(`Error fetching page data: ${e.message}\n${e.stack}`)
            );

            throw new Error(
              "The current user does not have access to this page. " +
                "Check your configuration to ensure the portalPageId is correct."
            );
          } else {
            throw e;
          }
        });

      if (typeof page.template_id !== "undefined") {
        this.#isV710OrHigher = true;
      }

      this.#pageTemplate = this.localTemplateHTML;

      this.#pageTemplate = this.#pageTemplate.replace(
        /%%PAGE TITLE%%/g,
        page.name || "Local template"
      );

      this.logger.info(colors.green("Local page template fetched"));

      this.#templateLoadedResolve(true);

      return this.#pageTemplate;
    }

    const pageList = await this.pageApi
      .getAll(this.#clearHeaders(headers))
      .then((response) => {
        this.logger.info(colors.green("Page list fetched"));

        return response;
      })
      .catch(async (e) => {
        this.#templateLoadedResolve(false);

        if (await this.pageApi.checkAuth(this.#clearHeaders(headers))) {
          this.logger.error(
            colors.red(`Error fetching page list: ${e.message}\n${e.stack}`)
          );

          throw new Error("Current user does not have access to page list");
        } else {
          throw e;
        }
      });

    let page = pageList.find((p) => p.name === TEMPLATE_PAGE_NAME);

    if (!page) {
      this.logger.warn(colors.yellow("Creating dev page template..."));

      page = await this.pageApi
        .create(
          {
            enabled: "Y",
            name: TEMPLATE_PAGE_NAME,
            internal_name: "dev-page-template",
            visible_in_homepage: "Y",
          },
          this.#clearHeaders(headers)
        )
        .then((response) => {
          this.logger.info(colors.green("Dev page created"));

          return response;
        })
        .catch((e) => {
          this.logger.error(
            colors.red(`Error creating dev page: ${e.message}`)
          );

          this.#templateLoadedResolve(false);

          throw new Error(
            `Error when creating dev page.
            That can be caused by missing permissions or page with name "${TEMPLATE_PAGE_NAME}" already exists`
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

        this.logger.info(colors.green("Page template fetched"));

        return response;
      })
      .catch((e) => {
        this.#templateLoadedResolve(false);

        this.logger.error(
          colors.red(`Error fetching page template: ${e.message}`)
        );

        throw new Error("Error fetching page template");
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
        const { tags = "[]", name, template } = response;

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
        this.logger.error(
          colors.red(`Error fetching page variables: ${reason.message}`)
        );

        if (reason.response?.status === 404) {
          throw new Error(
            `Portal Page with id "${pageId}" not found on instance ${this.#axios.getUri()}`
          );
        }

        if (reason.response?.status === 401) {
          console.log(`Unauthorized error: ${reason}`);

          throw new Error(
            `Current user does not have access to page with id "${pageId}" on instance ${this.#axios.getUri()}`
          );
        }

        throw reason;
      });
  }

  /**
   * Get page info
   *
   * @param pageId
   * @param headers
   */
  async getPageInfo(pageId: number, headers: Headers) {
    if (!this.portalPageId) {
      this.portalPageId = pageId;
    }

    const clearHeaders = this.#clearHeaders(headers);
    const pageIdToFetch = this.portalPageId!;

    try {
      if (this.#v7Features) {
        return await this.#fetchV7Page(pageIdToFetch, clearHeaders);
      }

      return await this.#fetchLegacyPage(pageIdToFetch, clearHeaders);
    } catch (error) {
      this.#handlePageFetchError(error, pageIdToFetch);
    }
  }

  /**
   * Fetch page data for v7 features
   */
  async #fetchV7Page(pageId: number, headers: Headers) {
    const page = await this.pageApi.get(pageId, headers);

    this.logger.info(colors.green("Page fetched"));

    if (typeof page.template_id !== "undefined") {
      this.#isV710OrHigher = true;
    }

    return page;
  }

  /**
   * Fetch page data for legacy features
   */
  async #fetchLegacyPage(pageId: number, headers: Headers) {
    return await this.pageApi.get(pageId, headers);
  }

  /**
   * Handle page fetch errors with appropriate error messages
   */
  #handlePageFetchError(error: any, pageId: number) {
    if (this.#v7Features && error.message?.includes("access")) {
      throw new Error(
        "The current user does not have access to this page. " +
          "Check your configuration to ensure the portalPageId is correct."
      );
    }

    if (error.response?.status === 404) {
      throw new Error(
        `Portal Page with id "${pageId}" not found on instance ${this.#axios.getUri()}`
      );
    }

    if (error.response?.status === 401) {
      this.logger.error(
        colors.red(
          `Current user does not have access to page with id "${pageId}" on instance ${this.#axios.getUri()}`
        )
      );
    }

    // Re-throw the original error if it doesn't match any specific cases
    throw error;
  }

  /**
   * Build page with variables
   *
   * @param content
   * @param miHudLess
   */
  buildPage(content: string | Buffer, miHudLess = false) {
    let result =
      typeof content === "string" ? content : content.toString("utf-8");

    for (const v of this.#pageVars) {
      result = result.replace(new RegExp(`\\[${v.name}\\]`, "g"), v.value);
    }

    const dom = new JSDOM(miHudLess ? result : this.#pageTemplate!);

    const placeholderText = "%%PLACEHOLDER%%";

    if (!miHudLess) {
      const placeholder = dom.window.document.createElement("div");
      placeholder.innerHTML = placeholderText;

      const container = dom.window.document.querySelector(".main-side");

      if (container) {
        const scripts = container.querySelectorAll("script");

        if (scripts.length) {
          container.insertBefore(placeholder, scripts.item(scripts.length - 1));
        } else {
          container.append(placeholder);
        }
      } else {
        const container = dom.window.document.createElement("div");

        container.append(placeholder);

        dom.window.document.body.append(container);
      }

      const head = dom.window.document.querySelector("head")!;
      const title = head!.querySelector("title");

      if (title) {
        title.text = this.#pageTitle;
      } else {
        head.innerHTML += `<title>${this.#pageTitle}</title>`;
      }
    }

    const serializedDom = dom.serialize();

    return serializedDom.replace(
      new RegExp(`<div>\\s*${placeholderText}\\s*<\\/div>`, "i"),
      result
    );
  }

  async getAssets() {
    if (this.portalPageId) {
      if (this.templateLess) {
        return await this.assetsApi.downloadPageAssets(
          this.portalPageId,
          this.#headers
        );
      } else {
        const pageInfo = await this.pageApi.get(
          this.portalPageId,
          this.#headers
        );

        if (this.#isV710OrHigher) {
          const templateInfo = await this.pageTemplateApi.get(
            pageInfo.template_id!,
            this.#headers
          );

          return await this.assetsApi.downloadTemplateAssets(
            templateInfo.id,
            this.#headers
          );
        } else {
          if (pageInfo.template) {
            return await this.assetsApi.downloadTemplateAssets(
              pageInfo.template,
              this.#headers
            );
          }
        }
      }
    }
  }

  async updateAssets(assets: Buffer) {
    if (this.portalPageId) {
      if (this.templateLess) {
        return await this.assetsApi.uploadPageAssets(
          this.portalPageId,
          assets,
          this.#headers
        );
      } else {
        const pageInfo = await this.pageApi.get(
          this.portalPageId,
          this.#headers
        );

        if (this.#isV710OrHigher) {
          const templateInfo = await this.pageTemplateApi.get(
            pageInfo.template_id!,
            this.#headers
          );

          return await this.assetsApi.uploadTemplateAssets(
            templateInfo.id,
            assets,
            this.#headers
          );
        } else {
          if (pageInfo.template) {
            return await this.assetsApi.uploadTemplateAssets(
              pageInfo.template,
              assets,
              this.#headers
            );
          }
        }
      }
    }
  }

  /**
   * Validate if the current token/credentials are still valid
   * @param headers Optional headers to use for validation
   * @returns Promise<boolean> - true if valid, false if invalid
   */
  async validateCredentials(
    headers?: Headers
  ): Promise<{ isValid: boolean; error?: string; code?: string }> {
    try {
      const testHeaders = headers || this.#headers;

      // Try to make a simple API call to validate credentials
      await this.get("/api/user", testHeaders, true);

      return { isValid: true };
    } catch (error: any) {
      const errorInfo = getTokenErrorInfo(error);

      return {
        isValid: false,
        error: errorInfo.userFriendlyMessage,
        code: errorInfo.code,
      };
    }
  }

  async get<T extends any = any>(
    path: string,
    headers?: Record<string, any>,
    cleanup = false
  ) {
    const normalizedHeaders = cleanup
      ? headers
      : Object.assign({}, this.#clearHeaders(this.#headers), headers);

    try {
      return await this.#axios.get<T>(path, {
        headers: normalizedHeaders,
      });
    } catch (error: any) {
      // Use the token helper for better error handling
      if (getTokenErrorInfo(error).code !== "UNKNOWN_ERROR") {
        const errorInfo = getTokenErrorInfo(error);
        this.logger.error(
          colors.red(`API request failed: ${errorInfo.userFriendlyMessage}`)
        );

        // Log detailed error information with suggestions
        logTokenError(this.logger, error, "API Request");

        // Preserve the original error structure but enhance it with our error info
        if (error.response) {
          // If it's already an Axios error, enhance it
          error.tokenErrorInfo = errorInfo;
        } else {
          // If it's a generic error, create a mock response structure
          (error as any).response = {
            status: errorInfo.status,
            data: { message: errorInfo.message },
          };
          error.tokenErrorInfo = errorInfo;
        }

        throw error;
      }

      // Re-throw other errors as-is
      throw error;
    }
  }
}
