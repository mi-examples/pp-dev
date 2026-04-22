import { describe, it, expect } from 'vitest';
import { gzipSync, brotliCompressSync, deflateSync, inflateSync } from 'zlib';
import { decodeContent, encodeContent } from '../../../src/lib/helpers/content-encoding.helper.js';

describe('Content Encoding Helper', () => {
  const plainContent = Buffer.from('Hello, World!', 'utf-8');

  describe('decodeContent', () => {
    it('should decompress gzip-encoded content', () => {
      const compressed = gzipSync(plainContent);
      const result = decodeContent(compressed, 'gzip');
      expect(result).toBeInstanceOf(Buffer);
      expect(result.toString('utf-8')).toBe('Hello, World!');
    });

    it('should decompress brotli-encoded content', () => {
      const compressed = brotliCompressSync(plainContent);
      const result = decodeContent(compressed, 'br');
      expect(result).toBeInstanceOf(Buffer);
      expect(result.toString('utf-8')).toBe('Hello, World!');
    });

    it('should decompress deflate-encoded content', () => {
      const compressed = deflateSync(plainContent);
      const result = decodeContent(compressed, 'deflate');
      expect(result).toBeInstanceOf(Buffer);
      expect(result.toString('utf-8')).toBe('Hello, World!');
    });

    it('should return content unchanged when encoding is undefined', () => {
      const result = decodeContent(plainContent);
      expect(result).toBe(plainContent);
    });

    it('should return content unchanged when encoding is empty string', () => {
      const result = decodeContent(plainContent, '');
      expect(result).toBe(plainContent);
    });

    it('should return content unchanged for unknown encoding', () => {
      const result = decodeContent(plainContent, 'unknown');
      expect(result).toBe(plainContent);
    });

    it('should handle empty buffer with default encoding', () => {
      const empty = Buffer.alloc(0);
      const result = decodeContent(empty);
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBe(0);
    });
  });

  describe('encodeContent', () => {
    it('should compress content with gzip', () => {
      const result = encodeContent(plainContent, 'gzip');
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBeLessThanOrEqual(plainContent.length + 50);
      expect(result.toString('utf-8')).not.toBe('Hello, World!');
    });

    it('should compress content with brotli', () => {
      const result = encodeContent(plainContent, 'br');
      expect(result).toBeInstanceOf(Buffer);
      expect(result.toString('utf-8')).not.toBe('Hello, World!');
    });

    it('should compress content with deflate', () => {
      const result = encodeContent(plainContent, 'deflate');
      expect(result).toBeInstanceOf(Buffer);
      expect(result.toString('utf-8')).not.toBe('Hello, World!');
    });

    it('should return content unchanged when encoding is undefined', () => {
      const result = encodeContent(plainContent);
      expect(result).toBe(plainContent);
    });

    it('should return content unchanged when encoding is empty string', () => {
      const result = encodeContent(plainContent, '');
      expect(result).toBe(plainContent);
    });

    it('should return content unchanged for unknown encoding', () => {
      const result = encodeContent(plainContent, 'identity');
      expect(result).toBe(plainContent);
    });

    it('should handle empty buffer', () => {
      const empty = Buffer.alloc(0);
      const result = encodeContent(empty, 'gzip');
      expect(result).toBeInstanceOf(Buffer);
    });
  });

  describe('round-trip encoding and decoding', () => {
    it('should round-trip gzip: encode then decode returns original', () => {
      const encoded = encodeContent(plainContent, 'gzip');
      const decoded = decodeContent(encoded, 'gzip');

      expect(decoded.toString('utf-8')).toBe('Hello, World!');
    });

    it('should round-trip brotli: encode then decode returns original', () => {
      const encoded = encodeContent(plainContent, 'br');
      const decoded = decodeContent(encoded, 'br');

      expect(decoded.toString('utf-8')).toBe('Hello, World!');
    });

    it('should round-trip deflate: encode then decode returns original', () => {
      const encoded = encodeContent(plainContent, 'deflate');
      const decoded = decodeContent(encoded, 'deflate');

      expect(decoded.toString('utf-8')).toBe('Hello, World!');
    });
  });
});
