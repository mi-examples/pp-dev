import { PPDevConfig } from '../index.js';
import { Connect } from 'vite';
import NextHandleFunction = Connect.NextHandleFunction;
import { cutUrlParams, redirect } from './helpers/url.helper.js';
import { Headers, MiAPI } from './pp.middleware.js';

export function initLoadPPData(applyUrlRegExp: RegExp, mi: MiAPI, opts: PPDevConfig): NextHandleFunction {
  const { templateLess = false, miHudLess = false, portalPageId } = opts;

  return (req, res, next) => {
    const isNeedTemplateLoad = !(templateLess && miHudLess);
    const isApplyRequest = applyUrlRegExp.test(cutUrlParams(req.url ?? ''));

    if (isNeedTemplateLoad && isApplyRequest) {
      const headers = (req.headers ?? {}) as Headers;

      const loadPageData =
        !templateLess && typeof portalPageId !== 'undefined'
          ? mi.getPageVariables(portalPageId, headers)
          : mi.getPageTemplate(headers);

      loadPageData
        .then(() => {
          next();
        })
        .catch((reason) => {
          if (reason.response) {
            return redirect(res, `/home?proxyRedirect=${encodeURIComponent('/')}`, 302);
          }

          next(reason);
        });
    } else {
      next();
    }
  };
}
