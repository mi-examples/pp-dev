import type { Application, Request, Response } from 'express';
import type { MiAPI } from './pp.middleware.js';
import { createLogger } from './logger.js';
import { getTokenErrorInfo } from './helpers/token.helper.js';
import { isSecureRequest, rewriteSetCookieHeader } from './helpers/cookie.helper.js';
import { redirect } from './helpers/url.helper.js';
import { invalidateProxyCache } from './proxy-cache.middleware.js';
import { getUserNameFromHost } from './user-registry.js';
import { startKeepingUsers } from './user-store.js';

/** Where the dev panel's token login form posts (see `helpers/login.helper.ts`). */
export const LOGIN_API_PATH = '/@api/login';

export interface LoginRouteOptions {
  miAPI: MiAPI;
  /** `users.persist`: with it on but no token at start, keeping the users starts at this login. */
  persistUsers: boolean;
  projectRoot: string;
  miUrl: string;
}

function sendErrorResponse(res: Response, status: number, error: string, details?: string, code?: string) {
  const response: { error: string; details?: string; code?: string } = { error };

  if (details) {
    response.details = details;
  }

  if (code) {
    response.code = code;
  }

  res.status(status).json(response).end();
}

/**
 * The token login behind the form pp-dev adds to MI's `/login` page: a personal access token
 * becomes the dev server's own (the original user's), a regular token becomes its MI session.
 *
 * One route for both dev servers: the form is injected by the proxy, which doesn't know which
 * server it runs under, and under `pp-dev next` the route used to be missing, so the form's request
 * never got an answer.
 */
export function registerLoginRoute(app: Application, opts: LoginRouteOptions): void {
  const { miAPI, persistUsers, projectRoot, miUrl } = opts;
  const logger = createLogger();

  const handleTokenValidationError = (res: Response, error: unknown, tokenType: string) => {
    logger.error(`${tokenType} token validation error: ${error instanceof Error ? error.message : String(error)}`);

    const errorInfo = getTokenErrorInfo(error);
    const enhancedErrorInfo = (error as { tokenErrorInfo?: Record<string, any> } | null)?.tokenErrorInfo;

    if (enhancedErrorInfo) {
      sendErrorResponse(
        res,
        enhancedErrorInfo.status || 500,
        enhancedErrorInfo.userFriendlyMessage,
        enhancedErrorInfo.message,
        enhancedErrorInfo.code,
      );

      return null;
    }

    let status: number;
    let errorMessage: string;
    let errorCode: string;

    switch (errorInfo.code) {
      case 'SESSION_EXPIRED':
        status = 412;
        errorMessage = tokenType === 'personal' ? 'Personal access token expired' : 'Session expired';
        errorCode = tokenType === 'personal' ? 'PAT_EXPIRED' : 'SESSION_EXPIRED';
        break;
      case 'UNAUTHORIZED':
        status = 401;
        errorMessage = 'Unauthorized';
        errorCode = 'UNAUTHORIZED';
        break;
      case 'FORBIDDEN':
        status = 403;
        errorMessage = 'Access forbidden';
        errorCode = 'FORBIDDEN';
        break;
      default:
        status = 500;
        errorMessage = 'Internal server error';
        errorCode = errorInfo.code;
    }

    const details =
      tokenType === 'personal' && errorCode === 'PAT_EXPIRED'
        ? 'Your personal access token has expired. Please generate a new token from the portal.'
        : tokenType === 'regular' && errorCode === 'SESSION_EXPIRED'
          ? 'Your portal session has expired. Please refresh your token or re-authenticate.'
          : errorInfo.userFriendlyMessage;

    sendErrorResponse(res, status, errorMessage, details, errorCode);

    return null;
  };

  app.post(LOGIN_API_PATH, async (req: Request, res: Response) => {
    // No JSON or form body (a hand-made request): Express 5 leaves `req.body` undefined.
    const { token, tokenType } = (req.body ?? {}) as { token?: unknown; tokenType?: unknown };

    // This login sets the original user's token, which a saved user's tab must not change.
    if (getUserNameFromHost(req.headers.host)) {
      sendErrorResponse(
        res,
        409,
        'Token login is only available on the main host',
        'This tab belongs to a saved pp-dev user. Log in with a token on the main host (localhost).',
        'USER_HOST',
      );

      return;
    }

    if (typeof token !== 'string' || !token) {
      sendErrorResponse(res, 400, 'Token is required');

      return;
    }

    logger.info(`Attempting to validate ${String(tokenType)} token...`);

    if (tokenType === 'personal') {
      const testRequest = await miAPI
        .get<{ user: { user_id: number; username: string } }>(
          '/data/page/index/auth/info',
          {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
          },
          true,
        )
        .then((response) => {
          // MI's HTML maintenance page comes with a 200: not a verdict on the token.
          if (typeof response.data !== 'object' || response.data === null) {
            sendErrorResponse(
              res,
              502,
              'MI is unavailable',
              'The instance may be down or in maintenance mode. Please try again later.',
              'MI_UNAVAILABLE',
            );

            return null;
          }

          if (typeof response.data?.user?.user_id === 'number') {
            miAPI.personalAccessToken = token;

            logger.info(`Personal access token validated successfully for user ${response.data.user.user_id}`);

            return response;
          }

          sendErrorResponse(res, 400, 'Token expired or invalid');

          return null;
        })
        .catch((error: unknown) => handleTokenValidationError(res, error, 'personal'));

      if (!testRequest) {
        return;
      }

      invalidateProxyCache('logged in with a personal access token');

      // Users need your own token: with users.persist on but no token at start, keeping them
      // starts now.
      startKeepingUsers({ persist: persistUsers, miAPI, projectRoot, miUrl });

      redirect(res, '/', 302);
    } else if (tokenType === 'regular') {
      const testRequest = await miAPI
        .get<{ users: { user_id: number; username: string }[] }>(
          '/api/user',
          {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Token: token,
          },
          true,
        )
        .then((response) => {
          if (response.data?.users?.length) {
            miAPI.personalAccessToken = undefined;

            logger.info(`Regular token validated successfully for ${response.data.users.length} user(s)`);

            res.setHeader(
              'set-cookie',
              rewriteSetCookieHeader(response.headers['set-cookie'], isSecureRequest(req)) ?? '',
            );

            return response;
          }

          sendErrorResponse(res, 400, 'Token expired or invalid');

          return null;
        })
        .catch((error: unknown) => handleTokenValidationError(res, error, 'regular'));

      if (!testRequest) {
        return;
      }

      invalidateProxyCache('logged in with a token');

      redirect(res, '/', 302);
    } else {
      sendErrorResponse(
        res,
        400,
        'Invalid tokenType',
        'tokenType must be "personal" or "regular".',
        'INVALID_TOKEN_TYPE',
      );
    }
  });
}
