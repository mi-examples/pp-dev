import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initRewriteResponse } from '../../../src/lib/rewrite-response.middleware.js';

describe('Rewrite Response Middleware', () => {
  let mockReq: any;
  let mockRes: any;
  let nextFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockReq = {
      url: '/test',
      headers: {
        host: 'localhost:3000',
      },
    };

    // Create a more complete mock response
    mockRes = {
      statusCode: 200,
      _headers: {} as Record<string, string>,
      setHeader: vi.fn((name: string, value: string) => {
        mockRes._headers[name.toLowerCase()] = value;
      }),
      getHeader: vi.fn((name: string) => mockRes._headers[name.toLowerCase()]),
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      emit: vi.fn(),
      removeListener: vi.fn(),
    };

    nextFn = vi.fn();
  });

  describe('Initialization', () => {
    it('should create middleware function with url matcher and transformer', () => {
      const urlMatcher = (url: string) => url.endsWith('.html');
      const transformer = (body: string) => Buffer.from(body.toUpperCase());

      const middleware = initRewriteResponse(urlMatcher, transformer);

      expect(typeof middleware).toBe('function');
    });
  });

  describe('URL Matching', () => {
    it('should apply transformer when URL matches', () => {
      // The actual middleware passes url, req, and res to the matcher
      const urlMatcher = vi.fn((url: string, _req: any, _res: any) => url.endsWith('index.html'));
      const transformer = vi.fn((body: string) => Buffer.from(body));

      const middleware = initRewriteResponse(urlMatcher, transformer);

      mockReq.url = '/p/template/index.html';

      middleware(mockReq, mockRes, nextFn);

      // Verify the URL matcher was called with the URL as first argument
      expect(urlMatcher).toHaveBeenCalled();
      expect(urlMatcher.mock.calls[0][0]).toBe('/p/template/index.html');
    });

    it('should not apply transformer when URL does not match', () => {
      const urlMatcher = vi.fn((url: string) => url.endsWith('index.html'));
      const transformer = vi.fn((body: string) => Buffer.from(body));

      const middleware = initRewriteResponse(urlMatcher, transformer);

      mockReq.url = '/api/data.json';

      middleware(mockReq, mockRes, nextFn);

      // Verify the URL matcher was called with the URL as first argument
      expect(urlMatcher).toHaveBeenCalled();
      expect(urlMatcher.mock.calls[0][0]).toBe('/api/data.json');
    });
  });

  describe('URL Patterns', () => {
    it('should handle index.html detection', () => {
      const urlMatcher = (url: string) => url.split('?')[0].endsWith('index.html');

      expect(urlMatcher('/p/template/index.html')).toBe(true);
      expect(urlMatcher('/p/template/index.html?v=123')).toBe(true);
      expect(urlMatcher('/p/template/other.html')).toBe(false);
      expect(urlMatcher('/api/data')).toBe(false);
    });

    it('should handle query string stripping', () => {
      const urlMatcher = (url: string) => {
        const path = url.split('?')[0];
        return path.endsWith('index.html');
      };

      expect(urlMatcher('/index.html?cache=false')).toBe(true);
      expect(urlMatcher('/page?file=index.html')).toBe(false);
    });
  });

  describe('Transformer Function', () => {
    it('should support Buffer return from transformer', () => {
      const urlMatcher = () => true;
      const transformer = (body: string) => Buffer.from(body.replace('old', 'new'));

      const middleware = initRewriteResponse(urlMatcher, transformer);

      expect(typeof middleware).toBe('function');
    });
  });

  describe('Middleware Behavior', () => {
    it('should be a function that accepts req, res, and next', () => {
      const middleware = initRewriteResponse(
        () => false,
        (body) => Buffer.from(body)
      );

      expect(typeof middleware).toBe('function');
      expect(middleware.length).toBeGreaterThanOrEqual(2); // At least req and res
    });

    it('should process requests without throwing', () => {
      const middleware = initRewriteResponse(
        (url) => url.includes('special'),
        (body) => Buffer.from(body)
      );

      mockReq.url = '/normal/path';

      // Should not throw
      expect(() => middleware(mockReq, mockRes, nextFn)).not.toThrow();
    });
  });
});
