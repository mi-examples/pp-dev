import { IndexHtmlTransformResult, Plugin } from 'vite';
import proxyPassMiddleware from './lib/proxy-pass.middleware.js';
import { MiAPI } from './lib/pp.middleware.js';
import { redirect, urlReplacer } from './lib/helpers/url.helper.js';
import { ClientService } from './lib/client.service.js';
import { initProxyCache, invalidateProxyCache } from './lib/proxy-cache.middleware.js';
import { DistService } from './lib/dist.service.js';
import { initRewriteResponse } from './lib/rewrite-response.middleware.js';
import { initPPRedirect } from './lib/pp-redirect.middleware.js';
import { initLoadPPData } from './lib/load-pp-data.middleware.js';
import { createInternalServer } from './lib/internal.middleware.js';
import { colors, getTokenErrorInfo, isSecureRequest, rewriteSetCookieHeader } from './lib/helpers/index.js';
import { RequestStore } from './lib/request-store.js';
import { createRequestCaptureMiddleware } from './lib/request-capture.middleware.js';
import { registerInspectorRoutes, INSPECTOR_PATH } from './lib/request-inspector.js';
import { registerVariablesEditorRoutes, VARIABLES_EDITOR_PATH } from './lib/variables-editor.js';
import { createUserHostGuard, getUserNameFromHost } from './lib/user-registry.js';
import { registerUserRoutes, USERS_API_PATH } from './lib/user-routes.js';
import { startKeepingUsers } from './lib/user-store.js';

// Config types, validation and normalization live in a module without the server's dependencies.
export * from './lib/pp-dev-config.js';
import type { NormalizedVitePPDevOptions } from './lib/pp-dev-config.js';

// ─── Internal MiAPI config ────────────────────────────────────────────────────

interface MiAPIConfig {
  headers: {
    host: string;
    referer: string;
    origin: string;
  };
  appId?: number;
  templateLess: boolean;
  disableSSLValidation: boolean;
  v7Features: boolean;
  personalAccessToken?: string;
}

// ─── Vite plugin ──────────────────────────────────────────────────────────────

function vitePPDev(options: NormalizedVitePPDevOptions): Plugin {
  const {
    templateName,
    templateLess,
    backendBaseURL,
    miHudLess,
    appId,
    enableProxyCache,
    proxyCacheTTL,
    disableSSLValidation,
    outDir,
    distZip,
    versionPlugin,
    syncBackupsDir,
    syncMaxBackups,
    v7Features,
    personalAccessToken,
    inspectorEnabled,
    inspectorMaxMemory,
    inspectorCaptureLimit,
    devPanelPosition,
    devPanelHidden,
    devPanelAutoHide,
    persistUsers,
  } = options || {};

  let isFirstRequest = true;
  let clientService: ClientService | undefined;

  return {
    name: 'vite-pp-dev',
    apply: 'serve',
    // A `serve`-only plugin's closeBundle runs when the dev server closes (or restarts, which makes a
    // new one): the place to stop what the panel started, such as a sync's build.
    closeBundle() {
      clientService?.dispose();
      clientService = undefined;
    },
    config: (config) => {
      config.clientInjectionPlugin = {
        backendBaseURL,
        appId,
        templateLess,
        v7Features,
        devPanelPosition,
        devPanelHidden,
        devPanelAutoHide,
      };

      if (v7Features) {
        config.base = `/pl/${templateName}`;
      }

      return config;
    },
    transformIndexHtml: async (_html, _ctx) => {
      const result: IndexHtmlTransformResult = { html: _html, tags: [] };

      if (isFirstRequest) {
        isFirstRequest = false;
        result.tags.push({ tag: 'script', injectTo: 'body', children: `${Math.random()}` });
      }

      return result;
    },
    configureServer: (server) => {
      let base = server.config.base;

      if (!base.endsWith('/')) {
        base += '/';
      }

      const baseWithoutTrailingSlash = base.substring(0, base.lastIndexOf('/'));

      if (backendBaseURL) {
        // Before Vite's own middlewares: a user host with no saved user behind it gets nothing.
        server.middlewares.use(createUserHostGuard());
      }

      server.middlewares.use(initPPRedirect(base, templateName));

      if (inspectorEnabled !== false) {
        const reqStore = new RequestStore(inspectorMaxMemory);

        server.middlewares.use(createRequestCaptureMiddleware(reqStore, inspectorCaptureLimit));

        const internalServer = createInternalServer();

        registerInspectorRoutes(internalServer, reqStore, inspectorCaptureLimit);

        // Only route internal pp-dev paths into the Express app. Mounting it for all
        // paths would run its global express.json()/urlencoded() body parsers, which
        // consume the request stream before the proxy can pipe it to the backend
        // (the backend then waits for a body that never arrives and replies 408).
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith('/@api/') || req.url?.startsWith(INSPECTOR_PATH)) {
            internalServer(req as never, res as never, next);

            return;
          }

          next();
        });
      }

      if (backendBaseURL) {
        server.config.logger.info(colors.blue(`🌐 Backend URL: ${backendBaseURL}`));
        server.config.logger.info(colors.blue(`🆔 Custom App ID: ${appId}`));

        const baseUrlHost = new URL(backendBaseURL).host;

        const miConfig: MiAPIConfig = {
          headers: {
            host: baseUrlHost,
            referer: backendBaseURL,
            origin: backendBaseURL.replace(/^(https?:\/\/)([^/]+)(\/.*)?$/i, '$1$2'),
          },
          appId,
          templateLess,
          disableSSLValidation,
          v7Features,
          personalAccessToken: personalAccessToken ?? process.env.MI_ACCESS_TOKEN,
        };

        const mi = new MiAPI(backendBaseURL, miConfig);

        if (enableProxyCache) {
          let ttl = +proxyCacheTTL;

          if (!ttl || Number.isNaN(ttl) || ttl < 0) {
            ttl = 10 * 60 * 1000;
          }

          server.middlewares.use(initProxyCache({ devServer: server, ttl }));
        }

        const isIndexRegExp = new RegExp(`^((${base})|/)$`);

        server.middlewares.use(initLoadPPData(isIndexRegExp, mi, Object.assign({}, options, { appId, appBase: base })));

        server.middlewares.use(
          proxyPassMiddleware({
            devServer: server,
            baseURL: backendBaseURL,
            proxyIgnore: ['/@vite', '/@metricinsights', '/@', baseWithoutTrailingSlash],
            disableSSLValidation,
            miAPI: mi,
            templateName,
          }),
        );

        const sendErrorResponse = (res: any, status: number, error: string, details?: string, code?: string) => {
          const response: any = { error };

          if (details) {
            response.details = details;
          }

          if (code) {
            response.code = code;
          }

          res.status(status).json(response).end();
        };

        const handleTokenValidationError = (res: any, error: any, tokenType: string) => {
          server.config.logger.error(`${tokenType} token validation error:`, error);

          const errorInfo = getTokenErrorInfo(error);

          if (error.tokenErrorInfo) {
            const enhancedErrorInfo = error.tokenErrorInfo;

            sendErrorResponse(
              res,
              enhancedErrorInfo.status || 500,
              enhancedErrorInfo.userFriendlyMessage,
              enhancedErrorInfo.message,
              enhancedErrorInfo.code,
            );
          } else {
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
          }

          return null;
        };

        const internalServer = createInternalServer();

        internalServer.post('/@api/login', async (req, res, next) => {
          const { token, tokenType } = req.body;

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

          if (!token) {
            sendErrorResponse(res, 400, 'Token is required');

            return;
          }

          server.config.logger.info(`Attempting to validate ${tokenType} token...`);

          if (tokenType === 'personal') {
            const testRequest = await mi
              .get<{ user: { user_id: number; username: string } }>(
                '/data/page/index/auth/info',
                {
                  'Content-Type': 'application/json',
                  Accept: 'application/json',
                  Authorization: `Bearer ${token}`,
                },
                true,
              )
              .then(async (response) => {
                if (typeof response.data?.user?.user_id === 'number') {
                  mi.personalAccessToken = token;

                  server.config.logger.info(
                    `Personal access token validated successfully for user ${response.data.user.user_id}`,
                  );

                  return response;
                }

                sendErrorResponse(res, 400, 'Token expired or invalid');

                return null;
              })
              .catch((error: any) => handleTokenValidationError(res, error, 'personal'));

            if (!testRequest) {
              return;
            }

            invalidateProxyCache('logged in with a personal access token');

            // Users need your own token: with users.persist on but no token at start, keeping them
            // starts now.
            startKeepingUsers({
              persist: persistUsers,
              miAPI: mi,
              projectRoot: server.config.root || process.cwd(),
              miUrl: backendBaseURL,
            });

            redirect(res, '/', 302);
          } else if (tokenType === 'regular') {
            const testRequest = await mi
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
                  mi.personalAccessToken = undefined;

                  server.config.logger.info(
                    `Regular token validated successfully for ${response.data.users.length} user(s)`,
                  );

                  res.setHeader(
                    'set-cookie',
                    rewriteSetCookieHeader(response.headers['set-cookie'], isSecureRequest(req)) ?? '',
                  );

                  return response;
                }

                sendErrorResponse(res, 400, 'Token expired or invalid');

                return null;
              })
              .catch((error: any) => handleTokenValidationError(res, error, 'regular'));

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

        const distService = new DistService(
          templateName,
          Object.assign(
            {
              root: server.config.root,
              backupFolder: syncBackupsDir,
              maxBackups: syncMaxBackups,
              buildInputFolder: typeof distZip === 'object' ? (distZip.inDir ?? outDir) : outDir,
            },
            typeof distZip === 'object'
              ? {
                  distZipFolder: distZip.outDir,
                  distZipFilename: distZip.outFileName,
                }
              : undefined,
            typeof versionPlugin === 'object'
              ? {
                  versionFileTemplate: versionPlugin.versionFileTemplate,
                }
              : undefined,
          ),
        );

        clientService = new ClientService(server, { distService, miAPI: mi });
        registerVariablesEditorRoutes(internalServer, { distService, miAPI: mi });
        registerUserRoutes(internalServer, { miAPI: mi });
        startKeepingUsers({
          persist: persistUsers,
          miAPI: mi,
          projectRoot: server.config.root || process.cwd(),
          miUrl: backendBaseURL,
        });

        // IMPORTANT: mount `internalServer` only after all `.get`/`.post`/`.put`/... routes are
        // registered on it. Vite's own middleware-mounting (`server.middlewares.use`) sets a
        // `.route` string property on whatever's mounted (to track its mount path) — colliding
        // with and overwriting Express's own `app.route` *method*. Any route registered on this
        // app *after* it's been mounted crashes with "this.route is not a function".
        //
        // Only route internal pp-dev paths into the Express app (see the matching inspector
        // gate above) — mounting it for all paths would run its global express.json()/
        // urlencoded() body parsers, which consume the request stream before the proxy can
        // pipe it to the backend (the backend then waits for a body that never arrives and
        // replies 408).
        server.middlewares.use((req, res, next) => {
          if (
            req.url?.startsWith('/@api/login') ||
            req.url?.startsWith('/@api/variables/') ||
            req.url?.startsWith(USERS_API_PATH) ||
            req.url?.startsWith(VARIABLES_EDITOR_PATH)
          ) {
            internalServer(req as never, res as never, next);

            return;
          }

          next();
        });

        return () => {
          server.middlewares.use(
            initRewriteResponse(
              (url) => {
                return url.split('?')[0].endsWith('index.html');
              },
              (response, req) => {
                return Buffer.from(urlReplacer(baseUrlHost, req.headers.host ?? '', mi.buildPage(response, miHudLess)));
              },
            ),
          );
        };
      }
    },
  };
}

export default vitePPDev;
export { vitePPDev };
