import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initProxyCache } from '../../../src/lib/proxy-cache.middleware.js';

describe('Proxy Cache Middleware', () => {
  let mockDevServer: any;
  let mockReq: any;
  let mockRes: any;
  let nextFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDevServer = {
      middlewares: { use: vi.fn() },
      config: {
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      },
    };

    mockReq = {
      method: 'GET',
      url: '/api/test',
      headers: {},
    };

    mockRes = {
      statusCode: 200,
      setHeader: vi.fn(),
      getHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
    };

    nextFn = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should create middleware function', () => {
      const middleware = initProxyCache({ devServer: mockDevServer, ttl: 5000 });

      expect(typeof middleware).toBe('function');
    });

    it('should accept custom TTL', () => {
      const middleware = initProxyCache({ devServer: mockDevServer, ttl: 10000 });

      expect(typeof middleware).toBe('function');
    });
  });

  describe('Request Handling', () => {
    it('should call next for GET requests', () => {
      const middleware = initProxyCache({ devServer: mockDevServer, ttl: 5000 });

      middleware(mockReq, mockRes, nextFn);

      expect(nextFn).toHaveBeenCalled();
    });

    it('should call next for POST requests', () => {
      mockReq.method = 'POST';
      const middleware = initProxyCache({ devServer: mockDevServer, ttl: 5000 });

      middleware(mockReq, mockRes, nextFn);

      expect(nextFn).toHaveBeenCalled();
    });

    it('should handle requests with query parameters', () => {
      mockReq.url = '/api/test?param=value';
      const middleware = initProxyCache({ devServer: mockDevServer, ttl: 5000 });

      middleware(mockReq, mockRes, nextFn);

      expect(nextFn).toHaveBeenCalled();
    });
  });

  describe('Cache Behavior', () => {
    it('should not cache POST requests', () => {
      mockReq.method = 'POST';
      const middleware = initProxyCache({ devServer: mockDevServer, ttl: 5000 });

      // First request
      middleware(mockReq, mockRes, nextFn);

      // Second request
      middleware(mockReq, mockRes, nextFn);

      // Both should call next (no caching for POST)
      expect(nextFn).toHaveBeenCalledTimes(2);
    });

    it('should not cache PUT requests', () => {
      mockReq.method = 'PUT';
      const middleware = initProxyCache({ devServer: mockDevServer, ttl: 5000 });

      middleware(mockReq, mockRes, nextFn);

      expect(nextFn).toHaveBeenCalled();
    });

    it('should not cache DELETE requests', () => {
      mockReq.method = 'DELETE';
      const middleware = initProxyCache({ devServer: mockDevServer, ttl: 5000 });

      middleware(mockReq, mockRes, nextFn);

      expect(nextFn).toHaveBeenCalled();
    });
  });

  describe('URL Patterns', () => {
    it('should handle root URL', () => {
      mockReq.url = '/';
      const middleware = initProxyCache({ devServer: mockDevServer, ttl: 5000 });

      middleware(mockReq, mockRes, nextFn);

      expect(nextFn).toHaveBeenCalled();
    });

    it('should handle nested paths', () => {
      mockReq.url = '/api/v1/users/123/profile';
      const middleware = initProxyCache({ devServer: mockDevServer, ttl: 5000 });

      middleware(mockReq, mockRes, nextFn);

      expect(nextFn).toHaveBeenCalled();
    });

    it('should handle URLs with special characters', () => {
      mockReq.url = '/api/search?q=hello%20world&filter=name';
      const middleware = initProxyCache({ devServer: mockDevServer, ttl: 5000 });

      middleware(mockReq, mockRes, nextFn);

      expect(nextFn).toHaveBeenCalled();
    });
  });

  describe('TTL Configuration', () => {
    it('should accept very short TTL', () => {
      const middleware = initProxyCache({ devServer: mockDevServer, ttl: 100 });

      expect(typeof middleware).toBe('function');
    });

    it('should accept very long TTL', () => {
      const middleware = initProxyCache({ devServer: mockDevServer, ttl: 3600000 }); // 1 hour

      expect(typeof middleware).toBe('function');
    });
  });
});
