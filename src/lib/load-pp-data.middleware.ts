import { PPDevConfig } from '../index.js';
import { Connect } from 'vite';
import NextHandleFunction = Connect.NextHandleFunction;
import { cutUrlParams, redirect } from './helpers/url.helper.js';
import { Headers, MiAPI } from './pp.middleware.js';
import { createLogger } from './logger.js';
import { colors } from './helpers/color.helper.js';

export function initLoadPPData(applyUrlRegExp: RegExp, mi: MiAPI, opts: PPDevConfig): NextHandleFunction {
  const { templateLess = false, miHudLess = false, portalPageId } = opts;

  const logger = createLogger();

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
            const redirectUrl = `/home?proxyRedirect=${encodeURIComponent('/')}`;

            logger.info(colors.yellow(`Redirecting to: ${redirectUrl}`));

            return redirect(res, redirectUrl, 302);
          }

          next(reason);
        });
    } else {
      next();
    }
  };
}
