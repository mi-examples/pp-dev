import { colors } from './color.helper.js';

export interface TokenErrorInfo {
  status: number;
  message: string;
  code: string;
  userFriendlyMessage: string;
  suggestions: string[];
}

/** What a logger needs to report a token error. */
export interface TokenErrorLogger {
  error: (message: string) => void;
  info: (message: string) => void;
}

/** The parts of an HTTP client (axios) error read here; anything may be missing or of another type. */
interface HttpErrorLike {
  message?: unknown;
  response?: { status?: unknown; data?: { message?: unknown } | null } | null;
}

/**
 * The status and message of an error, whatever was thrown: `null`, a string, an error without a
 * response, a response whose `message` isn't a string. The 412 branch below lowercases the message,
 * which threw on anything but a string.
 */
function readError(error: unknown): { status: number; message: string } {
  const { message, response } = (typeof error === 'object' && error !== null ? error : {}) as HttpErrorLike;
  const status = typeof response?.status === 'number' ? response.status : 0;
  const responseMessage = response?.data?.message;

  if (typeof responseMessage === 'string' && responseMessage) {
    return { status, message: responseMessage };
  }

  if (typeof message === 'string' && message) {
    return { status, message };
  }

  return { status, message: typeof error === 'string' && error ? error : 'Unknown error' };
}

/**
 * Get user-friendly error information for token-related errors
 */
export function getTokenErrorInfo(error: unknown): TokenErrorInfo {
  const { status, message } = readError(error);

  switch (status) {
    case 412: {
      const lowerMessage = message.toLowerCase();

      if (lowerMessage.includes('session expired') || lowerMessage.includes('session has expired')) {
        return {
          status,
          message,
          code: 'SESSION_EXPIRED',
          userFriendlyMessage: 'Your session has expired',
          suggestions: [
            'Refresh your token in the portal',
            'Re-authenticate with the portal',
            'Check if your token has been revoked',
            'Ensure your token has the correct permissions',
          ],
        };
      }

      return {
        status,
        message,
        code: 'AUTH_FAILED',
        userFriendlyMessage: 'Authentication failed',
        suggestions: [
          'Verify your token is correct',
          'Check token permissions',
          "Ensure the token hasn't expired",
          'Try generating a new token',
        ],
      };
    }

    case 401:
      return {
        status,
        message,
        code: 'UNAUTHORIZED',
        userFriendlyMessage: 'Unauthorized access',
        suggestions: [
          'Check if your token is valid',
          'Verify you have the required permissions',
          "Ensure the token hasn't been revoked",
          'Try logging in again',
        ],
      };

    case 403:
      return {
        status,
        message,
        code: 'FORBIDDEN',
        userFriendlyMessage: 'Access forbidden',
        suggestions: [
          'Check your user permissions',
          'Verify the portal page ID is correct',
          'Ensure your token has the right scope',
          'Contact your administrator',
        ],
      };

    default:
      return {
        status,
        message,
        code: 'UNKNOWN_ERROR',
        userFriendlyMessage: 'An unexpected error occurred',
        suggestions: [
          'Check your network connection',
          'Verify the portal URL is correct',
          'Try again in a few moments',
          'Check the portal status',
        ],
      };
  }
}

/**
 * Log token error information in a user-friendly format
 */
export function logTokenError(logger: TokenErrorLogger, error: unknown, context?: string): void {
  const errorInfo = getTokenErrorInfo(error);
  const contextPrefix = context ? `[${context}] ` : '';

  logger.error(colors.red(`${contextPrefix}${errorInfo.userFriendlyMessage}`));
  logger.error(colors.red(`Status: ${errorInfo.status} (${errorInfo.code})`));
  logger.error(colors.red(`Details: ${errorInfo.message}`));

  if (errorInfo.suggestions.length > 0) {
    logger.info(colors.yellow('Suggestions:'));
    errorInfo.suggestions.forEach((suggestion, index) => {
      logger.info(colors.yellow(`  ${index + 1}. ${suggestion}`));
    });
  }
}

/**
 * Whether MI refused the request for want of a valid session or token (401, 403, 412).
 */
export function isTokenError(error: unknown): boolean {
  const { status } = readError(error);

  return status === 401 || status === 403 || status === 412;
}
