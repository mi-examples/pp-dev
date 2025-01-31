import { IndexHtmlTransformResult, normalizePath, Plugin } from 'vite';
import * as path from 'path';
import { PP_DEV_CLIENT_ENTRY, PACKAGE_NAME, VERSION, PP_DEV_PACKAGE_DIR } from '../constants.js';
import * as fs from 'fs';
import { AsyncTemplateFunction, compile } from 'ejs';
import { fileURLToPath } from 'url';

export interface ClientInjectionPluginOpts {
  backendBaseURL?: string;
  templateLess: boolean;
  portalPageId?: number;
  canSync?: boolean;
  v7Features?: boolean;
}

declare module 'vite' {
  interface UserConfig {
    clientInjectionPlugin?: ClientInjectionPluginOpts;
  }
}

const DIRNAME = path.dirname(
  (typeof __filename !== 'undefined' && __filename) || fileURLToPath(new URL('.', import.meta.url)),
);

const PACKAGE_IMPORT = `/${PACKAGE_NAME}/client`;
const CLIENT_PATH = `/${PACKAGE_IMPORT}`;

export function clientInjectionPlugin(opts?: ClientInjectionPluginOpts): Plugin {
  const clientPanelTpl = fs.readFileSync(path.resolve(DIRNAME, 'client', 'index.html'), {
    encoding: 'utf8',
    flag: 'r',
  });

  let render: AsyncTemplateFunction;
  let base = '';
  let baseChanged = false;

  return {
    name: 'pp-dev:client',
    apply: 'serve',
    config: (config) => {
      config.optimizeDeps?.exclude?.push(`${PACKAGE_NAME}/client`);

      return config;
    },
    resolveId(source) {
      const pkgRegExp = new RegExp(`^\\/?${PACKAGE_NAME}\\/client\\/(.*)$`);

      if (pkgRegExp.test(source)) {
        return {
          id: normalizePath(path.join(PP_DEV_PACKAGE_DIR, 'dist/client', source.replace(pkgRegExp, '$1'))),
        };
      }
    },
    transformIndexHtml: async (html, ctx) => {
      if (ctx.server?.config.base && base !== ctx.server?.config.base) {
        base = ctx.server.config.base;
        baseChanged = true;
      }

      const result: IndexHtmlTransformResult = {
        html,
        tags: [
          {
            tag: 'link',
            injectTo: 'head',
            attrs: { rel: 'stylesheet', href: path.posix.join(base, PACKAGE_NAME, 'client/client.css') },
          },
        ],
      };

      const {
        backendBaseURL,
        templateLess,
        portalPageId,
        canSync = true,
      } = opts || ctx.server?.config.clientInjectionPlugin || {};

      if (!render || baseChanged) {
        render = compile(
          clientPanelTpl.replace(new RegExp(`${CLIENT_PATH}`, 'g'), path.posix.join(base, PACKAGE_IMPORT)),
          { openDelimiter: '{', closeDelimiter: '}', async: true },
        );
      }

      result.tags.push({
        tag: 'div',
        injectTo: 'body-prepend',
        children: await render?.({ PACKAGE_NAME, VERSION, backendBaseURL, templateLess, portalPageId, canSync }),
      });

      result.tags.push({
        tag: 'script',
        injectTo: 'body-prepend',
        attrs: { src: path.posix.join(base, PACKAGE_NAME, 'client/client.js'), type: 'module' },
      });

      baseChanged = false;

      return result;
    },
    configureServer(server) {
      server.config.server?.fs?.allow?.push(
        normalizePath(path.resolve(server.config.root, path.dirname(PP_DEV_CLIENT_ENTRY))),
      );
    },
  };
}
