import { describe, it, expect } from 'vitest';
import { redirect, rewriteDataPagePathForV7Proxy, urlReplacer } from '../../../src/lib/helpers/url.helper.js';

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
      const result = urlReplacer('backend.com', 'localhost:5000', '<a href="http://backend.com/path">Link</a>');

      expect(result).toContain('localhost:5000/path');
    });

    it('should handle HTTPS URLs', () => {
      const result = urlReplacer('backend.com', 'localhost:5000', '<a href="https://backend.com/path">Link</a>');

      expect(result).toContain('localhost:5000/path');
    });

    it('should preserve URLs from different hosts', () => {
      const result = urlReplacer('api.example.com', 'localhost:3000', '<a href="https://other.com/path">Link</a>');

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

    it('matches the dots in the host literally', () => {
      const content = 'https://api.example.com/a https://apiXexample.com/b';

      expect(urlReplacer('api.example.com', 'localhost', content)).toBe('http://localhost/a https://apiXexample.com/b');
    });

    it('gives the same result when called again for the same host', () => {
      const content = 'https://api.com/a https://api.com/b';

      expect(urlReplacer('api.com', 'localhost', content)).toBe('http://localhost/a http://localhost/b');
      expect(urlReplacer('api.com', 'localhost', content)).toBe('http://localhost/a http://localhost/b');
    });

    // The MI host has no port since `mi.url`'s default one is dropped (`https://mi.example.com:443`
    // → `mi.example.com`): a link written with the port became `http://localhost:3000:443/home`.
    it("replaces a URL that writes out its scheme's default port, port and all", () => {
      const content = [
        'https://mi.example.com:443/home',
        'http://mi.example.com:80/a',
        String.raw`"https:\/\/mi.example.com:443\/b"`,
      ].join(' ');

      expect(urlReplacer('mi.example.com', 'localhost:3000', content)).toBe(
        ['http://localhost:3000/home', 'http://localhost:3000/a', String.raw`"http:\/\/localhost:3000\/b"`].join(' '),
      );
    });

    it('leaves a URL on another port of the host alone', () => {
      const content = 'https://mi.example.com:8443/x http://mi.example.com:443/y https://mi.example.com/z';

      expect(urlReplacer('mi.example.com', 'localhost:3000', content)).toBe(
        'https://mi.example.com:8443/x http://mi.example.com:443/y http://localhost:3000/z',
      );
    });

    it('keeps a URL marked with !!, port and all, without the marker', () => {
      expect(urlReplacer('mi.example.com', 'localhost:3000', '!!https://mi.example.com:443/keep')).toBe(
        'https://mi.example.com:443/keep',
      );
    });

    // Any colon in the host turned the port matching off, and an IPv6 host has colons of its own.
    it('treats the ports of an IPv6 host the same way', () => {
      const content = 'https://[2001:db8::1]:443/home https://[2001:db8::1]:8443/x https://[2001:db8::1]/y';

      expect(urlReplacer('[2001:db8::1]', 'localhost:3000', content)).toBe(
        'http://localhost:3000/home https://[2001:db8::1]:8443/x http://localhost:3000/y',
      );
      expect(urlReplacer('[2001:db8::1]:8443', 'localhost:3000', 'https://[2001:db8::1]:8443/x')).toBe(
        'http://localhost:3000/x',
      );
    });

    it('matches a host configured with its port as written', () => {
      expect(urlReplacer('mi.example.com:8443', 'localhost:3000', 'https://mi.example.com:8443/x')).toBe(
        'http://localhost:3000/x',
      );
    });
  });

  describe('rewriteDataPagePathForV7Proxy', () => {
    it('should rewrite first /data/page/ segment when v7 and names differ', () => {
      expect(rewriteDataPagePathForV7Proxy('/data/page/npm-name/auth/info', true, 'npm-name', 'real-internal')).toBe(
        '/data/page/real-internal/auth/info',
      );
    });

    it('should preserve query string', () => {
      expect(rewriteDataPagePathForV7Proxy('/data/page/npm-name/x?a=1', true, 'npm-name', 'real-internal')).toBe(
        '/data/page/real-internal/x?a=1',
      );
    });

    it('should not rewrite when v7Features is false', () => {
      const url = '/data/page/npm-name/x';
      expect(rewriteDataPagePathForV7Proxy(url, false, 'npm-name', 'real-internal')).toBe(url);
    });

    it('should not rewrite when template and internal name match', () => {
      const url = '/data/page/same/x';
      expect(rewriteDataPagePathForV7Proxy(url, true, 'same', 'same')).toBe(url);
    });

    it('should not rewrite when path segment does not match templateName', () => {
      const url = '/data/page/index/auth/info';
      expect(rewriteDataPagePathForV7Proxy(url, true, 'my-app', 'internal-slug')).toBe(url);
    });

    it('should match URL-encoded segment to templateName', () => {
      expect(rewriteDataPagePathForV7Proxy('/data/page/foo%20bar/x', true, 'foo bar', 'internal')).toBe(
        '/data/page/internal/x',
      );
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
