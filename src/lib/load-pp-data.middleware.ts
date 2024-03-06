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

      logger.info(colors.green(`Start loading page data`));

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
            logger.info(colors.red('Page data loading failed. Not authorized'));

            const redirectUrl = `/home?proxyRedirect=${encodeURIComponent('/')}`;

            logger.info(colors.yellow(`Redirecting to: ${redirectUrl}`));

            return redirect(res, redirectUrl, 302);
          }

          logger.info(colors.red(`Page data loading failed. Error: ${reason.message}`));

          next(reason);
        });
    } else {
      next();
    }
  };
}
