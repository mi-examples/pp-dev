import { Connect } from 'vite';
import NextHandleFunction = Connect.NextHandleFunction;
import { redirect } from './helpers/url.helper.js';
import { URL } from 'url';

export function initPPRedirect(base: string, templateName?: string): NextHandleFunction {
  base = base.startsWith('/') ? base : `/${base}`;
  base = base.endsWith('/') ? base : `${base}/`;

  const baseWithoutTrailingSlash = base.endsWith('/') ? base.slice(0, -1) : base;

  return (req, res, next) => {
    const parsedUrl = new URL(req.url ?? '', 'http://localhost');
    const { pathname, search } = parsedUrl;
    const findPaths = ['/', baseWithoutTrailingSlash];

    if (templateName) {
      findPaths.push(`/pt/${templateName}`);
    }

    // Redirect from `/` and `/pt/${templateName}` and `${base}` (without a training slash) to portal page address
    if (findPaths.includes(pathname)) {
      const redirectUrl = `${base}${search}`;

      return redirect(res, redirectUrl, 302);
    }

    next();
  };
}
