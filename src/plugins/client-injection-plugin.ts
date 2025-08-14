import { IndexHtmlTransformResult, normalizePath, Plugin } from "vite";
import * as path from "path";
import {
  PP_DEV_CLIENT_ENTRY,
  PACKAGE_NAME,
  VERSION,
  PP_DEV_PACKAGE_DIR,
} from "../constants.js";
import * as fs from "fs";
import { AsyncTemplateFunction, compile } from "ejs";
import { fileURLToPath } from "url";

export interface ClientInjectionPluginOpts {
  backendBaseURL?: string;
  templateLess: boolean;
  portalPageId?: number;
  canSync?: boolean;
  v7Features?: boolean;
  enableCache?: boolean;
  maxCacheSize?: number;
}

declare module "vite" {
  interface UserConfig {
    clientInjectionPlugin?: ClientInjectionPluginOpts;
  }
}

// Simple LRU Cache implementation for better memory management
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private _maxSize: number;

  constructor(maxSize: number = 10) {
    this._maxSize = maxSize;
  }

  get maxSize(): number {
    return this._maxSize;
  }

  set maxSize(value: number) {
    this._maxSize = value;
  }

  get(key: K): V | undefined {
    if (this.cache.has(key)) {
      const value = this.cache.get(key)!;

      this.cache.delete(key);
      this.cache.set(key, value);

      return value;
    }
    return undefined;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this._maxSize) {
      const firstKey = this.cache.keys().next().value;

      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }
}

// Cache for template compilation and file reading with LRU strategy
const templateCache = new LRUCache<string, AsyncTemplateFunction>(5);
const fileCache = new Map<string, string>();

// Memoized path resolution
const DIRNAME = path.dirname(
  (typeof __filename !== "undefined" && __filename) ||
    fileURLToPath(new URL(".", import.meta.url))
);

// Pre-computed constants
const PACKAGE_IMPORT = `/${PACKAGE_NAME}/client`;
const CLIENT_PATH = `/${PACKAGE_IMPORT}`;
const PACKAGE_REGEXP = new RegExp(`^\\/?${PACKAGE_NAME}\\/client\\/(.*)$`);

// Memoized function to get template with caching
function getTemplate(
  base: string,
  enableCache: boolean = true
): AsyncTemplateFunction {
  const cacheKey = base;

  if (enableCache && templateCache.has(cacheKey)) {
    return templateCache.get(cacheKey)!;
  }

  // Read template file with caching
  const templatePath = path.resolve(DIRNAME, "client", "index.html");
  let templateContent: string;

  if (fileCache.has(templatePath)) {
    templateContent = fileCache.get(templatePath)!;
  } else {
    templateContent = fs.readFileSync(templatePath, { encoding: "utf8" });
    fileCache.set(templatePath, templateContent);
  }

  // Compile template with optimized replacement and better regex escaping
  const escapedClientPath = CLIENT_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const compiledTemplate = compile(
    templateContent.replace(
      new RegExp(escapedClientPath, "g"),
      path.posix.join(base, PACKAGE_IMPORT)
    ),
    {
      openDelimiter: "{",
      closeDelimiter: "}",
      async: true,
      cache: true, // Enable EJS internal caching
      filename: templatePath, // For better error reporting
      rmWhitespace: true, // Remove unnecessary whitespace
      compileDebug: false, // Disable debug info in production
    }
  );

  if (enableCache) {
    templateCache.set(cacheKey, compiledTemplate);
  }

  return compiledTemplate;
}

// Memoized function to get CSS and JS paths
function getAssetPaths(base: string) {
  return {
    css: path.posix.join(base, PACKAGE_NAME, "client/client.css"),
    js: path.posix.join(base, PACKAGE_NAME, "client/client.js"),
  };
}

// Performance monitoring (only in development)
const performanceMetrics = {
  templateCompilations: 0,
  cacheHits: 0,
  totalRequests: 0,
};

export function clientInjectionPlugin(
  opts?: ClientInjectionPluginOpts
): Plugin {
  const enableCache = opts?.enableCache ?? true;
  const maxCacheSize = opts?.maxCacheSize ?? 5;

  // Update cache size if specified
  if (maxCacheSize !== 5) {
    templateCache.maxSize = maxCacheSize;
  }

  let base = "";
  let baseChanged = false;
  let currentTemplate: AsyncTemplateFunction | null = null;

  return {
    name: "pp-dev:client",
    apply: "serve",

    config: (config) => {
      config.optimizeDeps?.exclude?.push(`${PACKAGE_NAME}/client`);

      return config;
    },

    resolveId(source) {
      if (PACKAGE_REGEXP.test(source)) {
        return {
          id: normalizePath(
            path.join(
              PP_DEV_PACKAGE_DIR,
              "dist/client",
              source.replace(PACKAGE_REGEXP, "$1")
            )
          ),
        };
      }
    },

    transformIndexHtml: async (html, ctx) => {
      performanceMetrics.totalRequests++;

      const serverBase = ctx.server?.config.base || "";

      if (serverBase !== base) {
        base = serverBase;
        baseChanged = true;
        currentTemplate = null;
      }

      // Get or create template only when needed
      if (!currentTemplate || baseChanged) {
        if (enableCache && templateCache.has(base)) {
          currentTemplate = templateCache.get(base)!;
          performanceMetrics.cacheHits++;
        } else {
          currentTemplate = getTemplate(base, enableCache);
          performanceMetrics.templateCompilations++;
        }

        baseChanged = false;
      }

      const assetPaths = getAssetPaths(base);

      const result: IndexHtmlTransformResult = {
        html,
        tags: [
          {
            tag: "link",
            injectTo: "head",
            attrs: {
              rel: "stylesheet",
              href: assetPaths.css,
            },
          },
        ],
      };

      const {
        backendBaseURL,
        templateLess,
        portalPageId,
        canSync = true,
      } = opts || ctx.server?.config.clientInjectionPlugin || {};

      // Render template content
      const templateData = {
        PACKAGE_NAME,
        VERSION,
        backendBaseURL,
        templateLess,
        portalPageId,
        canSync,
      };

      result.tags.push({
        tag: "div",
        injectTo: "body-prepend",
        children: await currentTemplate(templateData),
      });

      result.tags.push({
        tag: "script",
        injectTo: "body-prepend",
        attrs: {
          src: assetPaths.js,
          type: "module",
        },
      });

      return result;
    },

    configureServer(server) {
      const clientDir = normalizePath(
        path.resolve(server.config.root, path.dirname(PP_DEV_CLIENT_ENTRY))
      );

      if (server.config.server?.fs?.allow) {
        server.config.server.fs.allow.push(clientDir);
      }

      // Log performance metrics in development
      server.middlewares.use(`/@api/__pp-dev-metrics`, (req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(performanceMetrics, null, 2));
      });
    },

    // Cleanup function to clear caches when plugin is destroyed
    closeBundle() {
      templateCache.clear();
      fileCache.clear();

      console.log(`[pp-dev:client] Performance metrics:`, performanceMetrics);
    },
  };
}
