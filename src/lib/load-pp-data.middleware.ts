import type { NormalizedVitePPDevOptions } from '../plugin.js';
import type { NextHandleFunction, IncomingMessage, NextFunction } from 'connect';
import { cutUrlParams, redirect } from './helpers/url.helper.js';
import { Headers, MiAPI } from './pp.middleware.js';
import { createLogger } from './logger.js';
import { colors } from './helpers/color.helper.js';
import { ServerResponse } from 'http';
import { cache } from './proxy-cache.middleware.js';
import { authProvider } from './auth.provider.js';

// Types for better type safety
interface LoadPPDataOptions {
  appId: number;
  templateLess: boolean;
  miHudLess: boolean;
  redirectOnAuthFailure?: boolean;
  redirectUrl?: string;
  timeout?: number;
}

// Performance optimization: Simple cache for API responses
const apiResponseCache = new Map<string, { timestamp: number; data: any }>();
const CACHE_TTL = 3 * 60 * 1000; // 3 minutes

function getCachedResponse(key: string): any | null {
  const cached = apiResponseCache.get(key);
  if (!cached) return null;

  if (Date.now() - cached.timestamp > CACHE_TTL) {
    apiResponseCache.delete(key);

    return null;
  }

  return cached.data;
}

function setCachedResponse(key: string, data: any): void {
  apiResponseCache.set(key, { timestamp: Date.now(), data });
}

// Constants
const DEFAULT_REDIRECT_URL = '/home?proxyRedirect=';

/**
 * Whether the request is a top-level HTML document navigation (as opposed to an
 * asset/XHR/HMR request). Used to detect deep-linked page loads so template data
 * can be loaded even when the first request is not the main page URL.
 */
function isHtmlDocumentRequest(req: IncomingMessage): boolean {
  const dest = req.headers['sec-fetch-dest'];

  if (typeof dest === 'string') {
    return dest === 'document';
  }

  // Fallback for clients that don't send Sec-Fetch-* headers.
  const accept = req.headers['accept'];

  return typeof accept === 'string' && accept.includes('text/html');
}

/**
 * Whether the request path is served by this dev app (under its base path).
 * An empty/`/` base means the app is served from the root.
 */
function isUnderBase(requestPath: string, base?: string): boolean {
  if (!base || base === '/') {
    return true;
  }

  const normalizedBase = base.endsWith('/') ? base : `${base}/`;

  return requestPath === normalizedBase || requestPath === normalizedBase.slice(0, -1) || requestPath.startsWith(normalizedBase);
}

export function initLoadPPData(
  applyUrlRegExp: RegExp,
  mi: MiAPI,
  opts: Partial<NormalizedVitePPDevOptions> & { base?: string; appBase?: string },
): NextHandleFunction {
  const { templateLess = false, miHudLess = false, appId, base, appBase, v7Features } = opts;

  const logger = createLogger();

  // Validate required configuration
  if (templateLess && miHudLess && typeof appId === 'undefined') {
    throw new Error('Custom App ID is required when both templateLess and miHudLess are true');
  }

  return async (req: IncomingMessage, res: ServerResponse, next: NextFunction) => {
    try {
      const isNeedTemplateLoad = !(templateLess && miHudLess);
      const requestPath = cutUrlParams(req.url ?? '');
      const isApplyRequest = applyUrlRegExp.test(requestPath);

      // A deep-linked navigation into the app (e.g. an SPA sub-route) that is not the
      // exact main page URL. Without loading here, template variables would never be
      // fetched when the very first request is such a sub-path. Excludes `/home`,
      // which is handled by the auth/redirect block above. The load itself is cached,
      // so this stays a no-op after the first navigation.
      const isAppNavigation =
        !isApplyRequest &&
        !requestPath.startsWith('/home') &&
        isUnderBase(requestPath, appBase) &&
        isHtmlDocumentRequest(req);

      const authState = authProvider.getState();

      // 1. If !isAuthenticated && !isRedirected and url started with /home - try to handle load page or template
      if (
        !authState.isAuthenticated &&
        !authState.isRedirected &&
        // For MI redirect to home page
        req.url?.startsWith('/home') &&
        // For helper old URL with proxyRedirect param (will redirect to base or login page based on auth state)
        !req.url?.startsWith(DEFAULT_REDIRECT_URL)
      ) {
        logger.info(colors.blue('Trying to authenticate and redirect to base'));

        try {
          if (!isNeedTemplateLoad) {
            await handlePageInfoOnly(
              mi,
              {
                templateLess,
                miHudLess,
                appId: appId!,
                redirectUrl: v7Features && base ? `${base}` : `${DEFAULT_REDIRECT_URL}${encodeURIComponent('/')}`,
              },
              req,
              res,
              () => {},
              logger,
            );
          } else {
            await handleTemplateLoad(
              mi,
              {
                templateLess,
                miHudLess,
                appId: appId!,
                redirectUrl: v7Features && base ? `${base}` : `${DEFAULT_REDIRECT_URL}${encodeURIComponent('/')}`,
              },
              req,
              res,
              () => {},
              logger,
            );
          }

          authProvider.setRedirected(true);

          logger.info(colors.blue('Successfully authenticated. Redirecting to base'));

          return redirect(res, base ?? '/', 302);
        } catch (error) {
          // If load throws an error, run next()
          return next();
        }
      }

      // Default case - continue with normal flow
      if (!isApplyRequest && !isAppNavigation) {
        return next();
      }

      if (!isNeedTemplateLoad) {
        const result = await handlePageInfoOnly(
          mi,
          {
            templateLess,
            miHudLess,
            appId: appId!,
            redirectUrl: v7Features && base ? `${base}` : `${DEFAULT_REDIRECT_URL}${encodeURIComponent('/')}`,
          },
          req,
          res,
          next,
          logger,
        );

        return result;
      }

      const result = await handleTemplateLoad(
        mi,
        {
          templateLess,
          miHudLess,
          appId: appId!,
          redirectUrl: v7Features && base ? `${base}` : `${DEFAULT_REDIRECT_URL}${encodeURIComponent('/')}`,
        },
        req,
        res,
        next,
        logger,
      );

      return result;
    } catch (error) {
      logger.error(
        colors.red(
          `Unexpected error in load-pp-data middleware: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );

      authProvider.reset();

      return next(error);
    }
  };
}

/**
 * Handle requests that only need page info (no template loading)
 */
async function handlePageInfoOnly(
  mi: MiAPI,
  options: LoadPPDataOptions,
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFunction,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const { appId, redirectOnAuthFailure, redirectUrl } = options;

  if (typeof appId === 'undefined') {
    const error = new Error('Custom App ID is required for page info only mode');

    logger.error(colors.red(error.message));

    return next(error);
  }

  const headers = (req.headers ?? {}) as Headers;

  logger.info(colors.green('Start loading page info'));

  try {
    // Performance optimization: Check cache first
    const cacheKey = `pageInfo:${appId}`;
    const cachedData = getCachedResponse(cacheKey);

    if (cachedData) {
      logger.info(colors.green('Page info loaded from cache'));
      return next();
    }

    await mi.getPageInfo(appId, headers);

    logger.info(colors.blue('Clearing proxy cache after successful login'));
    cache.clear();

    // Cache the successful response
    setCachedResponse(cacheKey, { success: true });

    authProvider.updateState({ isAuthenticated: true });

    logger.info(colors.green('Page info loaded successfully'));

    return next();
  } catch (error) {
    authProvider.reset();

    return handleLoadError(
      error,
      redirectOnAuthFailure ?? true,
      redirectUrl || `${DEFAULT_REDIRECT_URL}${encodeURIComponent('/')}`,
      res,
      next,
      logger,
      'Page info',
    );
  }
}

/**
 * Handle requests that need template loading
 */
async function handleTemplateLoad(
  mi: MiAPI,
  options: LoadPPDataOptions,
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFunction,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const { templateLess, appId, redirectOnAuthFailure, redirectUrl } = options;
  const headers = (req.headers ?? {}) as Headers;

  logger.info(colors.green('Start loading page data'));

  try {
    // Performance optimization: Check cache first
    const cacheKey = `pageData:${templateLess}:${appId}`;
    const cachedData = getCachedResponse(cacheKey);

    if (cachedData) {
      logger.info(colors.green('Page data loaded from cache'));
      return next();
    }

    const loadPageData =
      !templateLess && typeof appId !== 'undefined' ? mi.getPageVariables(appId, headers) : mi.getPageTemplate(headers);

    await loadPageData;

    logger.info(colors.blue('Clearing proxy cache after successful login'));
    cache.clear();

    // Cache the successful response
    setCachedResponse(cacheKey, { success: true });

    logger.info(colors.green('Page data loaded successfully'));

    return next();
  } catch (error) {
    authProvider.reset();

    return handleLoadError(
      error,
      redirectOnAuthFailure ?? true,
      redirectUrl || `${DEFAULT_REDIRECT_URL}${encodeURIComponent('/')}`,
      res,
      next,
      logger,
      'Page data',
    );
  }
}

/**
 * Centralized error handling for load operations
 */
function handleLoadError(
  error: unknown,
  redirectOnAuthFailure: boolean,
  redirectUrl: string,
  res: ServerResponse,
  next: NextFunction,
  logger: ReturnType<typeof createLogger>,
  operationType: string,
): void {
  // Check if it's an authorization error
  if (isAuthError(error)) {
    logger.info(colors.red(`${operationType} loading failed. Not authorized`));

    if (redirectOnAuthFailure) {
      const fullRedirectUrl = `${redirectUrl}`;

      logger.info(colors.yellow(`Redirecting to: ${fullRedirectUrl}`));

      return redirect(res, fullRedirectUrl, 302);
    }
  }

  // Handle other errors
  const errorMessage = error instanceof Error ? error.message : String(error);

  logger.info(colors.red(`${operationType} loading failed. Error: ${errorMessage}`));

  // Pass error to next middleware for proper error handling
  return next(error);
}

/**
 * Type guard to check if error is an authorization error
 */
function isAuthError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'response' in error && error.response !== undefined;
}

// Export cache management for external use
export function clearAPICache(): void {
  apiResponseCache.clear();
}

export function getAPICacheStats(): { size: number; entries: string[] } {
  return {
    size: apiResponseCache.size,
    entries: Array.from(apiResponseCache.keys()),
  };
}
