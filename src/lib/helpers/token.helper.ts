import { colors } from './color.helper.js';

export interface TokenValidationResult {
  isValid: boolean;
  error?: string;
  code?: string;
  suggestions?: string[];
}

export interface TokenErrorInfo {
  status: number;
  message: string;
  code: string;
  userFriendlyMessage: string;
  suggestions: string[];
}

/**
 * Get user-friendly error information for token-related errors
 */
export function getTokenErrorInfo(error: any): TokenErrorInfo {
  const status = error.response?.status || 0;
  const message = error.response?.data?.message || error.message || 'Unknown error';
  
  switch (status) {
    case 412:
      if (message.toLowerCase().includes('session expired')) {
        return {
          status,
          message,
          code: 'SESSION_EXPIRED',
          userFriendlyMessage: 'Your session has expired',
          suggestions: [
            'Refresh your token in the portal',
            'Re-authenticate with the portal',
            'Check if your token has been revoked',
            'Ensure your token has the correct permissions'
          ]
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
          'Ensure the token hasn\'t expired',
          'Try generating a new token'
        ]
      };
      
    case 401:
      return {
        status,
        message,
        code: 'UNAUTHORIZED',
        userFriendlyMessage: 'Unauthorized access',
        suggestions: [
          'Check if your token is valid',
          'Verify you have the required permissions',
          'Ensure the token hasn\'t been revoked',
          'Try logging in again'
        ]
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
          'Contact your administrator'
        ]
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
          'Check the portal status'
        ]
      };
  }
}

/**
 * Log token error information in a user-friendly format
 */
export function logTokenError(logger: any, error: any, context?: string): void {
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
 * Check if an error is a token-related authentication error
 */
export function isTokenError(error: any): boolean {
  const status = error.response?.status;
  return status === 401 || status === 403 || status === 412;
}

/**
 * Check if an error indicates an expired session
 */
export function isSessionExpiredError(error: any): boolean {
  return error.response?.status === 412 && 
         error.response?.data?.message?.toLowerCase().includes('session expired');
}
