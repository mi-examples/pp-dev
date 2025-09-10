import { PPDevConfig } from '../index.js';
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
  templateLess: boolean;
  miHudLess: boolean;
  portalPageId?: number;
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

export function initLoadPPData(
  applyUrlRegExp: RegExp,
  mi: MiAPI,
  opts: PPDevConfig & { base?: string },
): NextHandleFunction {
  const { templateLess = false, miHudLess = false, portalPageId, base, v7Features } = opts;

  const logger = createLogger();

  // Validate required configuration
  if (templateLess && miHudLess && typeof portalPageId === 'undefined') {
    throw new Error('Portal page ID is required when both templateLess and miHudLess are true');
  }

  let authState = authProvider.getState();

  authProvider.subscribe((state) => {
    authState = state;
  });

  return async (req, res, next) => {
    try {
      const isNeedTemplateLoad = !(templateLess && miHudLess);
      const isApplyRequest = applyUrlRegExp.test(cutUrlParams(req.url ?? ''));

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
                portalPageId,
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
                portalPageId,
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
      if (!isApplyRequest) {
        return next();
      }

      if (!isNeedTemplateLoad) {
        const result = await handlePageInfoOnly(
          mi,
          {
            templateLess,
            miHudLess,
            portalPageId,
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
          portalPageId,
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
  const { portalPageId, redirectOnAuthFailure, redirectUrl } = options;

  if (typeof portalPageId === 'undefined') {
    const error = new Error('Portal page ID is required for page info only mode');

    logger.error(colors.red(error.message));

    return next(error);
  }

  const headers = (req.headers ?? {}) as Headers;

  logger.info(colors.green('Start loading page info'));

  try {
    // Performance optimization: Check cache first
    const cacheKey = `pageInfo:${portalPageId}`;
    const cachedData = getCachedResponse(cacheKey);

    if (cachedData) {
      logger.info(colors.green('Page info loaded from cache'));
      return next();
    }

    await mi.getPageInfo(portalPageId, headers);

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
  const { templateLess, portalPageId, redirectOnAuthFailure, redirectUrl } = options;
  const headers = (req.headers ?? {}) as Headers;

  logger.info(colors.green('Start loading page data'));

  try {
    // Performance optimization: Check cache first
    const cacheKey = `pageData:${templateLess}:${portalPageId}`;
    const cachedData = getCachedResponse(cacheKey);

    if (cachedData) {
      logger.info(colors.green('Page data loaded from cache'));
      return next();
    }

    const loadPageData =
      !templateLess && typeof portalPageId !== 'undefined'
        ? mi.getPageVariables(portalPageId, headers)
        : mi.getPageTemplate(headers);

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
