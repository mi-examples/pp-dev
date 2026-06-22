import { IndexHtmlTransformResult, normalizePath, Plugin } from 'vite';
import * as path from 'path';
import { PP_DEV_CLIENT_ENTRY, PACKAGE_NAME, VERSION, PP_DEV_PACKAGE_DIR } from '../constants.js';
import { getDevPanelAssetPaths } from '../lib/dev-panel.js';
import * as fs from 'fs';
import ejs from 'ejs';
import type { AsyncTemplateFunction } from 'ejs';
import { fileURLToPath } from 'url';

export interface ClientInjectionPluginOpts {
  backendBaseURL?: string;
  templateLess: boolean;
  appId?: number;
  canSync?: boolean;
  v7Features?: boolean;
}

declare module 'vite' {
  interface UserConfig {
    clientInjectionPlugin?: ClientInjectionPluginOpts;
  }
}

// Memoized path resolution
// Support both CJS and ESM contexts
let DIRNAME: string;
try {
  // @ts-ignore - __filename is available in CJS
  if (typeof __filename !== 'undefined' && __filename) {
    // @ts-ignore - __filename is available in CJS
    DIRNAME = path.resolve(path.dirname(__filename), '..');
  } else if (typeof import.meta !== 'undefined' && import.meta && import.meta.url) {
    DIRNAME = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
  } else {
    // Fallback to current working directory
    DIRNAME = process.cwd();
  }
} catch {
  // Fallback to current working directory if all else fails
  DIRNAME = process.cwd();
}

const PACKAGE_REGEXP = new RegExp(`^\\/?${PACKAGE_NAME}\\/client\\/(.*)$`);

let cachedTemplateContent: string | null = null;
let cachedTemplate: AsyncTemplateFunction | null = null;

function getTemplate(): AsyncTemplateFunction {
  if (cachedTemplate) {
    return cachedTemplate;
  }
  const templatePath = path.resolve(DIRNAME, 'client', 'index.html');
  if (!cachedTemplateContent) {
    cachedTemplateContent = fs.readFileSync(templatePath, { encoding: 'utf8' });
  }
  cachedTemplate = ejs.compile(cachedTemplateContent, {
    openDelimiter: '{',
    closeDelimiter: '}',
    async: true,
    cache: true,
    filename: templatePath,
    rmWhitespace: true,
    compileDebug: false,
  });
  return cachedTemplate;
}

// Memoized function to get CSS and JS paths

export function clientInjectionPlugin(opts?: ClientInjectionPluginOpts): Plugin {
  return {
    name: 'pp-dev:client',
    apply: 'serve',

    config: (config) => {
      config.optimizeDeps?.exclude?.push(`${PACKAGE_NAME}/client`);

      return config;
    },

    resolveId(source) {
      if (PACKAGE_REGEXP.test(source)) {
        return {
          id: normalizePath(path.join(PP_DEV_PACKAGE_DIR, 'dist/client', source.replace(PACKAGE_REGEXP, '$1'))),
        };
      }
    },

    transformIndexHtml: async (html, ctx) => {
      const base = ctx.server?.config.base || '';
      const template = getTemplate();
      const assetPaths = getDevPanelAssetPaths(base);

      const result: IndexHtmlTransformResult = {
        html,
        tags: [
          {
            tag: 'link',
            injectTo: 'head',
            attrs: {
              rel: 'stylesheet',
              href: assetPaths.css,
            },
          },
        ],
      };

      const {
        backendBaseURL,
        templateLess,
        appId,
        canSync = true,
      } = opts || ctx.server?.config.clientInjectionPlugin || {};

      const templateData = {
        PACKAGE_NAME,
        VERSION,
        backendBaseURL,
        templateLess,
        appId,
        canSync,
      };

      result.tags.push({
        tag: 'div',
        injectTo: 'body-prepend',
        children: await template(templateData),
      });

      result.tags.push({
        tag: 'script',
        injectTo: 'body-prepend',
        attrs: {
          src: assetPaths.js,
          type: 'module',
        },
      });

      return result;
    },

    configureServer(server) {
      const clientDir = normalizePath(path.resolve(server.config.root, path.dirname(PP_DEV_CLIENT_ENTRY)));

      if (server.config.server?.fs?.allow) {
        server.config.server.fs.allow.push(clientDir);
      }
    },
  };
}
