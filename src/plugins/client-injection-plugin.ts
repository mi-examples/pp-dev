import { IndexHtmlTransformResult, normalizePath, Plugin } from 'vite';
import * as path from 'path';
import { PP_DEV_CLIENT_ENTRY, PACKAGE_NAME, PP_DEV_PACKAGE_DIR } from '../constants.js';
import { getDevPanelAssetPaths, renderDevPanelMarkup } from '../lib/dev-panel.js';
import type { DevPanelPosition } from '../plugin.js';

export interface ClientInjectionPluginOpts {
  backendBaseURL?: string;
  templateLess: boolean;
  appId?: number;
  canSync?: boolean;
  v7Features?: boolean;
  devPanelPosition?: DevPanelPosition;
  devPanelHidden?: boolean;
  devPanelAutoHide?: boolean;
}

declare module 'vite' {
  interface UserConfig {
    clientInjectionPlugin?: ClientInjectionPluginOpts;
  }
}

const CLIENT_DIST_DIR = normalizePath(path.join(PP_DEV_PACKAGE_DIR, 'dist/client'));
const PACKAGE_REGEXP = new RegExp(`^\\/?${PACKAGE_NAME}\\/client\\/(.*)$`);

export function clientInjectionPlugin(opts?: ClientInjectionPluginOpts): Plugin {
  return {
    name: 'pp-dev:client',
    apply: 'serve',

    config: (config) => {
      config.optimizeDeps?.exclude?.push(`${PACKAGE_NAME}/client`);

      return config;
    },

    resolveId(source) {
      const match = source.match(PACKAGE_REGEXP);

      if (match) {
        const resolvedId = normalizePath(path.join(CLIENT_DIST_DIR, match[1]));

        if (!resolvedId.startsWith(`${CLIENT_DIST_DIR}/`)) {
          return null;
        }

        return {
          id: resolvedId,
        };
      }
    },

    transformIndexHtml: async (html, ctx) => {
      const base = ctx.server?.config.base || '';
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

      // The same markup `pp-dev next` injects: one template, compiled once, with one set of defaults.
      const { templateLess = false, ...panelOptions } = opts || ctx.server?.config.clientInjectionPlugin || {};

      result.tags.push({
        tag: 'div',
        injectTo: 'body-prepend',
        children: renderDevPanelMarkup({ templateLess, ...panelOptions }),
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
