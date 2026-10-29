import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTokenErrorInfo, isTokenError, logTokenError } from '../../../src/lib/helpers/token.helper.js';

describe('Token Helper', () => {
  describe('getTokenErrorInfo', () => {
    it('should return SESSION_EXPIRED for 412 with session expired message', () => {
      const error = {
        response: {
          status: 412,
          data: { message: 'Your session has expired. Please log in again.' },
        },
      };

      const result = getTokenErrorInfo(error);

      expect(result.status).toBe(412);
      expect(result.code).toBe('SESSION_EXPIRED');
      expect(result.userFriendlyMessage).toBe('Your session has expired');
      expect(result.suggestions).toHaveLength(4);
      expect(result.suggestions[0]).toContain('Refresh your token');
    });

    it('should return SESSION_EXPIRED when message has mixed case', () => {
      const error = {
        response: {
          status: 412,
          data: { message: 'SESSION EXPIRED' },
        },
      };

      const result = getTokenErrorInfo(error);

      expect(result.code).toBe('SESSION_EXPIRED');
    });

    it('should return AUTH_FAILED for 412 without session expired message', () => {
      const error = {
        response: {
          status: 412,
          data: { message: 'Precondition failed' },
        },
      };

      const result = getTokenErrorInfo(error);

      expect(result.status).toBe(412);
      expect(result.code).toBe('AUTH_FAILED');
      expect(result.userFriendlyMessage).toBe('Authentication failed');
    });

    it('should return UNAUTHORIZED for 401', () => {
      const error = {
        response: {
          status: 401,
          data: { message: 'Invalid token' },
        },
      };

      const result = getTokenErrorInfo(error);

      expect(result.status).toBe(401);
      expect(result.code).toBe('UNAUTHORIZED');
      expect(result.userFriendlyMessage).toBe('Unauthorized access');
    });

    it('should return FORBIDDEN for 403', () => {
      const error = {
        response: {
          status: 403,
          data: { message: 'Access denied' },
        },
      };

      const result = getTokenErrorInfo(error);

      expect(result.status).toBe(403);
      expect(result.code).toBe('FORBIDDEN');
      expect(result.userFriendlyMessage).toBe('Access forbidden');
    });

    it('should return UNKNOWN_ERROR for unexpected status codes', () => {
      const error = {
        response: {
          status: 500,
          data: { message: 'Internal server error' },
        },
      };

      const result = getTokenErrorInfo(error);

      expect(result.status).toBe(500);
      expect(result.code).toBe('UNKNOWN_ERROR');
      expect(result.userFriendlyMessage).toBe('An unexpected error occurred');
    });

    it('should use error.message when response.data.message is missing', () => {
      const error = {
        message: 'Network error',
        response: { status: 404 },
      };

      const result = getTokenErrorInfo(error);

      expect(result.message).toBe('Network error');
    });

    it('should default to Unknown error when no message available', () => {
      const error = { response: { status: 503 } };

      const result = getTokenErrorInfo(error);

      expect(result.message).toBe('Unknown error');
    });

    it('should handle errors without response (status 0)', () => {
      const error = { message: 'Connection refused' };

      const result = getTokenErrorInfo(error);

      expect(result.status).toBe(0);
      expect(result.code).toBe('UNKNOWN_ERROR');
    });
  });

  describe('isTokenError', () => {
    it('should return true for 401', () => {
      expect(isTokenError({ response: { status: 401 } })).toBe(true);
    });

    it('should return true for 403', () => {
      expect(isTokenError({ response: { status: 403 } })).toBe(true);
    });

    it('should return true for 412', () => {
      expect(isTokenError({ response: { status: 412 } })).toBe(true);
    });

    it('should return false for 404', () => {
      expect(isTokenError({ response: { status: 404 } })).toBe(false);
    });

    it('should return false for 500', () => {
      expect(isTokenError({ response: { status: 500 } })).toBe(false);
    });

    it('should return false when response is missing', () => {
      expect(isTokenError({})).toBe(false);
    });

    it('should return false when status is undefined', () => {
      expect(isTokenError({ response: {} })).toBe(false);
    });
  });

  // Every export took `error: any`, and a 412 lowercased whatever `message` was: `null` or an object
  // there threw inside the error handling itself.
  describe('getTokenErrorInfo with whatever was thrown', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'boom'],
      ['an object message on a 412', { response: { status: 412, data: { message: { text: 'x' } } } }],
      ['a null response', { response: null }],
      ['a numeric message', { message: 42 }],
    ])('does not throw on %s', (_name, error) => {
      expect(() => getTokenErrorInfo(error)).not.toThrow();
      expect(typeof getTokenErrorInfo(error).message).toBe('string');
    });

    it('reads a 412 with a non-string message as a failed authentication', () => {
      expect(getTokenErrorInfo({ response: { status: 412, data: { message: { text: 'x' } } } }).code).toBe(
        'AUTH_FAILED',
      );
    });

    it('keeps a thrown string as the message', () => {
      expect(getTokenErrorInfo('boom').message).toBe('boom');
    });

    it('does not take null for a token error', () => {
      expect(isTokenError(null)).toBe(false);
    });
  });

  describe('logTokenError', () => {
    let mockLogger: {
      error: ReturnType<typeof vi.fn>;
      info: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockLogger = {
        error: vi.fn(),
        info: vi.fn(),
      };
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should call logger.error with user-friendly message', () => {
      const error = { response: { status: 401 }, message: 'test' };

      logTokenError(mockLogger, error);

      expect(mockLogger.error).toHaveBeenCalled();
      const calls = mockLogger.error.mock.calls;
      expect(calls.some((c) => c[0].includes('Unauthorized access'))).toBe(true);
    });

    it('should include context prefix when provided', () => {
      const error = { response: { status: 403 } };

      logTokenError(mockLogger, error, 'MyContext');

      const firstCall = mockLogger.error.mock.calls[0][0];
      expect(firstCall).toContain('[MyContext]');
    });

    it('should call logger.info for suggestions', () => {
      const error = { response: { status: 401 } };

      logTokenError(mockLogger, error);

      expect(mockLogger.info).toHaveBeenCalled();
    });
  });
});
