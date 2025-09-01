import type { NextHandleFunction } from 'connect';
import { redirect } from './helpers/url.helper.js';
import { URL } from 'url';
import { createLogger } from './logger.js';
import { colors } from './helpers/color.helper.js';

export function initPPRedirect(base: string, templateName?: string): NextHandleFunction {
  base = base.startsWith('/') ? base : `/${base}`;
  base = base.endsWith('/') ? base : `${base}/`;

  const baseWithoutTrailingSlash = base.endsWith('/') ? base.slice(0, -1) : base;

  const logger = createLogger();

  return (req, res, next) => {
    const parsedUrl = new URL(req.url ?? '', 'http://localhost');
    const { pathname, search } = parsedUrl;
    const findPaths = ['/', baseWithoutTrailingSlash];

    if (templateName) {
      findPaths.push(`/pt/${templateName}`);
      findPaths.push(`/pl/${templateName}`);
    }

    // Redirect from `/` and `/pt/${templateName}` and `${base}` (without a training slash) to portal page address
    if (findPaths.includes(pathname)) {
      const redirectUrl = `${base}${search}`;

      logger.info(colors.yellow(`Redirecting to: ${redirectUrl}`));

      return redirect(res, redirectUrl, 302);
    }

    next();
  };
}
