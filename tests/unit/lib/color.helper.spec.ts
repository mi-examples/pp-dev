import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { colors } from '../../../src/lib/helpers/color.helper.js';

describe('Color Helper', () => {
  describe('colors object', () => {
    it('should have all expected color methods', () => {
      expect(typeof colors.red).toBe('function');
      expect(typeof colors.green).toBe('function');
      expect(typeof colors.yellow).toBe('function');
      expect(typeof colors.blue).toBe('function');
      expect(typeof colors.white).toBe('function');
    });

    it('should have formatting methods', () => {
      expect(typeof colors.bold).toBe('function');
      expect(typeof colors.dim).toBe('function');
      expect(typeof colors.reset).toBe('function');
    });

    it('should return string from color methods', () => {
      expect(typeof colors.red('test')).toBe('string');
      expect(typeof colors.green('test')).toBe('string');
      expect(typeof colors.yellow('test')).toBe('string');
      expect(typeof colors.blue('test')).toBe('string');
    });

    it('should return string from formatting methods', () => {
      expect(typeof colors.bold('test')).toBe('string');
      expect(typeof colors.dim('test')).toBe('string');
      expect(typeof colors.reset('test')).toBe('string');
    });

    it('should handle empty strings', () => {
      expect(colors.red('')).toBeDefined();
      expect(colors.bold('')).toBeDefined();
    });

    it('should handle strings with special characters', () => {
      const special = 'Test\n\t"special"';
      expect(() => colors.red(special)).not.toThrow();
      expect(() => colors.bold(special)).not.toThrow();
    });

    it('should allow chaining of methods', () => {
      const result = colors.bold(colors.red('test'));
      expect(typeof result).toBe('string');
    });
  });
});
