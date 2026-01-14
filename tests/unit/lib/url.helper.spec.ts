import { describe, it, expect } from 'vitest';
import { urlReplacer, redirect } from '../../../src/lib/helpers/url.helper.js';

describe('URL Helper', () => {
  describe('urlReplacer', () => {
    it('should replace backend host with local host in HTML content', () => {
      const backendHost = 'api.example.com';
      const localHost = 'localhost:3000';
      const html = `
        <html>
          <head>
            <link href="https://api.example.com/styles.css" rel="stylesheet">
          </head>
          <body>
            <script src="https://api.example.com/script.js"></script>
            <a href="https://api.example.com/page">Link</a>
          </body>
        </html>
      `;

      const result = urlReplacer(backendHost, localHost, html);

      expect(result).toContain('localhost:3000/styles.css');
      expect(result).toContain('localhost:3000/script.js');
      expect(result).toContain('localhost:3000/page');
      expect(result).not.toContain('api.example.com');
    });

    it('should handle HTTP URLs', () => {
      const result = urlReplacer(
        'backend.com',
        'localhost:5000',
        '<a href="http://backend.com/path">Link</a>'
      );

      expect(result).toContain('localhost:5000/path');
    });

    it('should handle HTTPS URLs', () => {
      const result = urlReplacer(
        'backend.com',
        'localhost:5000',
        '<a href="https://backend.com/path">Link</a>'
      );

      expect(result).toContain('localhost:5000/path');
    });

    it('should preserve URLs from different hosts', () => {
      const result = urlReplacer(
        'api.example.com',
        'localhost:3000',
        '<a href="https://other.com/path">Link</a>'
      );

      expect(result).toContain('https://other.com/path');
    });

    it('should handle empty content', () => {
      const result = urlReplacer('backend.com', 'localhost', '');
      expect(result).toBe('');
    });

    it('should handle content without URLs', () => {
      const content = '<div>Hello World</div>';
      const result = urlReplacer('backend.com', 'localhost', content);
      expect(result).toBe(content);
    });

    it('should handle multiple occurrences of the same host', () => {
      const html = `
        <link href="https://api.com/a.css">
        <link href="https://api.com/b.css">
        <script src="https://api.com/c.js"></script>
      `;

      const result = urlReplacer('api.com', 'localhost', html);

      expect(result).not.toContain('api.com');
      expect(result.match(/localhost/g)?.length).toBe(3);
    });
  });

  describe('redirect', () => {
    it('should send redirect response with correct headers', () => {
      const mockRes = {
        statusCode: 0,
        setHeader: vi.fn(),
        end: vi.fn(),
      };

      redirect(mockRes as any, '/new-path', 302);

      expect(mockRes.statusCode).toBe(302);
      // Note: implementation uses lowercase 'location'
      expect(mockRes.setHeader).toHaveBeenCalledWith('location', '/new-path');
      expect(mockRes.end).toHaveBeenCalled();
    });

    it('should use 302 as default status code', () => {
      const mockRes = {
        statusCode: 0,
        setHeader: vi.fn(),
        end: vi.fn(),
      };

      redirect(mockRes as any, '/path');

      expect(mockRes.statusCode).toBe(302);
    });

    it('should support 301 permanent redirect', () => {
      const mockRes = {
        statusCode: 0,
        setHeader: vi.fn(),
        end: vi.fn(),
      };

      redirect(mockRes as any, '/permanent', 301);

      expect(mockRes.statusCode).toBe(301);
    });

    it('should handle absolute URLs', () => {
      const mockRes = {
        statusCode: 0,
        setHeader: vi.fn(),
        end: vi.fn(),
      };

      redirect(mockRes as any, 'https://example.com/path', 302);

      // Note: implementation uses lowercase 'location'
      expect(mockRes.setHeader).toHaveBeenCalledWith('location', 'https://example.com/path');
    });
  });
});

// Import vi for mocking
import { vi } from 'vitest';
