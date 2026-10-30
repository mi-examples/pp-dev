/**
 * Serves the pp-dev pages built from src/client/<name> into dist/client (the Request Inspector,
 * the Variables Editor): the page itself, with its `{{placeholders}}` filled in, and its script,
 * styles and source maps.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Application } from 'express';
import { PP_DEV_CLIENT_ENTRY } from '../constants.js';

/** Where the client build puts the pages' files (next to the dev panel's). */
export const CLIENT_DIST_DIR = path.dirname(PP_DEV_CLIENT_ENTRY);

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export interface ClientPageOptions {
  /** Where the page is served, e.g. `/@pp-dev/inspector`; its files under `<path>/<file>`. */
  path: string;
  /** The bundle's name: `<name>.html`, `<name>.js`, `<name>.css` in `clientDir`. */
  name: string;
  /** The values of the page's `{{placeholders}}`, read on every request. */
  values?: () => Record<string, string>;
  /** Where the built files are. Tests pass their own. @default CLIENT_DIST_DIR */
  clientDir?: string;
}

export function serveClientPage(app: Application, opts: ClientPageOptions): void {
  const clientDir = opts.clientDir ?? CLIENT_DIST_DIR;
  // Only the page's own files: nothing else in the folder, and no path in the name.
  const files = new Set([`${opts.name}.js`, `${opts.name}.css`, `${opts.name}.js.map`, `${opts.name}.css.map`]);

  app.get(opts.path, (_req, res) => {
    fs.readFile(path.join(clientDir, `${opts.name}.html`), 'utf-8', (error, html) => {
      if (error) {
        res.status(500).type('text/plain').end(`${opts.name} page not built (${error.message})`);

        return;
      }

      const values = opts.values?.() ?? {};

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(html.replace(/\{\{(\w+)\}\}/g, (placeholder, key: string) => values[key] ?? placeholder));
    });
  });

  app.get(`${opts.path}/:file`, (req, res, next) => {
    const file = req.params.file;

    if (!files.has(file)) {
      next();

      return;
    }

    fs.readFile(path.join(clientDir, file), (error, content) => {
      if (error) {
        next();

        return;
      }

      res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(content);
    });
  });
}
