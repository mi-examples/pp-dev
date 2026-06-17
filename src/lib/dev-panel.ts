import * as fs from 'fs';
import * as path from 'path';
import ejs from 'ejs';
import type { TemplateFunction } from 'ejs';
import type { IncomingMessage, ServerResponse } from 'http';
import { PACKAGE_NAME, VERSION, PP_DEV_CLIENT_ENTRY } from '../constants.js';

/**
 * Shared dev-panel rendering and serving, framework-agnostic.
 *
 * The Vite path injects the panel via `clientInjectionPlugin.transformIndexHtml`.
 * The `pp-dev next` server has no such hook, so it uses these helpers to render the
 * same EJS panel, inject it into page HTML, and serve the client assets that Vite
 * would otherwise resolve.
 */

export interface DevPanelData {
  backendBaseURL?: string;
  templateLess: boolean;
  portalPageId?: number;
  canSync?: boolean;
}

/** Directory holding the built client assets (`client.js`, `client.css`, `index.html`). */
const CLIENT_DIST_DIR = path.dirname(PP_DEV_CLIENT_ENTRY);
const TEMPLATE_PATH = path.join(CLIENT_DIST_DIR, 'index.html');

let compiledTemplate: TemplateFunction | null = null;

function getTemplate(): TemplateFunction {
  if (compiledTemplate) {
    return compiledTemplate;
  }

  const templateContent = fs.readFileSync(TEMPLATE_PATH, { encoding: 'utf8' });

  compiledTemplate = ejs.compile(templateContent, {
    openDelimiter: '{',
    closeDelimiter: '}',
    async: false,
    rmWhitespace: true,
    compileDebug: false,
  });

  return compiledTemplate;
}

/** Public URLs (under `base`) for the dev-panel client assets. */
export function getDevPanelAssetPaths(base: string) {
  return {
    css: path.posix.join(base, PACKAGE_NAME, 'client/client.css'),
    js: path.posix.join(base, PACKAGE_NAME, 'client/client.js'),
  };
}

/** Render the dev-panel markup (the floating info panel + sync button). */
export function renderDevPanelMarkup(data: DevPanelData): string {
  const template = getTemplate();

  return template({
    PACKAGE_NAME,
    VERSION,
    backendBaseURL: data.backendBaseURL,
    templateLess: data.templateLess,
    portalPageId: data.portalPageId,
    canSync: data.canSync ?? true,
  }) as string;
}

/**
 * Inject the dev panel (CSS link in `<head>`, panel markup + client script at the
 * start of `<body>`) into a full HTML document. Returns the original HTML unchanged
 * if it is not a parseable HTML document.
 *
 * Must run before host-rewriting (e.g. `urlReplacer`) so the panel's `!!`-prefixed
 * backend links are handled consistently with the rest of the page.
 */
export function injectDevPanel(html: string, base: string, data: DevPanelData): string {
  if (!/<\/?(html|body|head)\b/i.test(html)) {
    return html;
  }

  const { css, js } = getDevPanelAssetPaths(base);
  const panelMarkup = renderDevPanelMarkup(data);

  const linkTag = `<link rel="stylesheet" href="${css}">`;
  const scriptTag = `<script type="module" src="${js}"></script>`;
  const bodyPrepend = `${panelMarkup}${scriptTag}`;

  let result = html;
  let linkInjected = false;

  if (/<\/head>/i.test(result)) {
    result = result.replace(/<\/head>/i, `${linkTag}</head>`);
    linkInjected = true;
  }

  if (/<body[^>]*>/i.test(result)) {
    const head = linkInjected ? '' : linkTag;

    result = result.replace(/(<body[^>]*>)/i, `$1${head}${bodyPrepend}`);
  } else {
    // No <body>: append everything (covers fragment-like responses that still passed the guard).
    result = `${linkInjected ? '' : linkTag}${result}${bodyPrepend}`;
  }

  return result;
}

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Connect-style middleware that serves the dev-panel client assets
 * (`client.js`, `client.css`, and their source maps) at `{base}{PACKAGE_NAME}/client/*`.
 * Calls `next()` for any non-matching request.
 */
export function createDevPanelAssetMiddleware(base: string) {
  const assetPrefix = path.posix.join(base, PACKAGE_NAME, 'client') + '/';
  const allowed = new Set(['client.js', 'client.css', 'client.js.map', 'client.css.map']);

  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const pathname = (req.url ?? '').split('?')[0];

    if (!pathname.startsWith(assetPrefix)) {
      next();

      return;
    }

    const fileName = pathname.slice(assetPrefix.length);

    if (!allowed.has(fileName)) {
      next();

      return;
    }

    const filePath = path.join(CLIENT_DIST_DIR, fileName);

    fs.readFile(filePath, (err, content) => {
      if (err) {
        next();

        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', CONTENT_TYPES[path.extname(fileName)] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(content);
    });
  };
}
