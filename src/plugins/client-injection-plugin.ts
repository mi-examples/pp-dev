import { IndexHtmlTransformResult, normalizePath, Plugin } from 'vite';
import * as path from 'path';
import { PP_DEV_CLIENT_ENTRY, PACKAGE_NAME, VERSION, PP_DEV_PACKAGE_DIR } from '../constants.js';
import * as fs from 'fs';
import { AsyncTemplateFunction, compile } from 'ejs';
import * as url from 'url';

export interface ClientInjectionPluginOpts {
  backendBaseURL?: string;
  templateLess: boolean;
  portalPageId?: number;
}

declare module 'vite' {
  interface UserConfig {
    clientInjectionPlugin?: ClientInjectionPluginOpts;
  }
}

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

const PACKAGE_IMPORT = `${PACKAGE_NAME}/client`;
const CLIENT_PATH = `/${PACKAGE_IMPORT}`;

export function clientInjectionPlugin(opts?: ClientInjectionPluginOpts): Plugin {
  const clientPanelTpl = fs.readFileSync(path.resolve(__dirname, '..', 'client', 'index.html'), {
    encoding: 'utf8',
    flag: 'r',
  });
  let render: AsyncTemplateFunction;

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
      const result: IndexHtmlTransformResult = {
        html,
        tags: [
          { tag: 'link', injectTo: 'head', attrs: { rel: 'stylesheet', href: `${PACKAGE_NAME}/client/client.css` } },
          { tag: 'script', injectTo: 'body', attrs: { src: `${PACKAGE_NAME}/client/client.js`, type: 'module' } },
        ],
      };

      const { backendBaseURL, templateLess, portalPageId } = opts || ctx.server?.config.clientInjectionPlugin || {};

      if (!render && ctx.server?.config.base) {
        render = compile(
          clientPanelTpl.replace(
            new RegExp(`${CLIENT_PATH}`, 'g'),
            path.posix.join(ctx.server.config.base, PACKAGE_IMPORT),
          ),
          { openDelimiter: '{', closeDelimiter: '}', async: true },
        );
      }

      if (ctx.server?.config.base) {
        result.tags.push({
          tag: 'div',
          injectTo: 'body',
          children: await render({ PACKAGE_NAME, VERSION, backendBaseURL, templateLess, portalPageId }),
        });
      }

      return result;
    },
    configureServer(server) {
      server.config.server?.fs?.allow?.push(
        normalizePath(path.resolve(server.config.root, path.dirname(PP_DEV_CLIENT_ENTRY))),
      );
    },
  };
}
