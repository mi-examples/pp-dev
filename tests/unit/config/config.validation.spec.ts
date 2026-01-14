import { describe, it, expect } from 'vitest';

// Import the constants to test config file name patterns
import { PP_DEV_CONFIG_NAMES, PP_WATCH_CONFIG_NAMES } from '../../../src/constants.js';

describe('Config Validation', () => {
  describe('PP_DEV_CONFIG_NAMES', () => {
    it('should include all supported config file names', () => {
      expect(PP_DEV_CONFIG_NAMES).toContain('pp-dev.config.ts');
      expect(PP_DEV_CONFIG_NAMES).toContain('pp-dev.config.js');
      expect(PP_DEV_CONFIG_NAMES).toContain('pp-dev.config.json');
      expect(PP_DEV_CONFIG_NAMES).toContain('pp-dev.config.cjs');
      expect(PP_DEV_CONFIG_NAMES).toContain('pp-dev.config.mjs');
      expect(PP_DEV_CONFIG_NAMES).toContain('pp-dev.config.cts');
      expect(PP_DEV_CONFIG_NAMES).toContain('pp-dev.config.mts');
    });

    it('should include dotfile config variants', () => {
      expect(PP_DEV_CONFIG_NAMES).toContain('.pp-dev.config.ts');
      expect(PP_DEV_CONFIG_NAMES).toContain('.pp-dev.config.js');
      expect(PP_DEV_CONFIG_NAMES).toContain('.pp-dev.config.json');
      expect(PP_DEV_CONFIG_NAMES).toContain('.pp-dev.config.cjs');
      expect(PP_DEV_CONFIG_NAMES).toContain('.pp-dev.config.mjs');
      expect(PP_DEV_CONFIG_NAMES).toContain('.pp-dev.config.cts');
      expect(PP_DEV_CONFIG_NAMES).toContain('.pp-dev.config.mts');
    });

    it('should have dotfile variants before regular variants (priority)', () => {
      const dotfileIndex = PP_DEV_CONFIG_NAMES.indexOf('.pp-dev.config.js');
      const regularIndex = PP_DEV_CONFIG_NAMES.indexOf('pp-dev.config.js');

      expect(dotfileIndex).toBeLessThan(regularIndex);
    });
  });

  describe('PP_WATCH_CONFIG_NAMES', () => {
    it('should include legacy pp-watch config file names', () => {
      expect(PP_WATCH_CONFIG_NAMES).toContain('.pp-watch.config.js');
      expect(PP_WATCH_CONFIG_NAMES).toContain('.pp-watch.config.ts');
      expect(PP_WATCH_CONFIG_NAMES).toContain('.pp-watch.config.json');
    });

    it('should only have 3 legacy config names', () => {
      expect(PP_WATCH_CONFIG_NAMES).toHaveLength(3);
    });
  });

  describe('Config File Extension Patterns', () => {
    const supportedExtensions = ['.ts', '.js', '.json', '.cjs', '.mjs', '.cts', '.mts'];

    it('should support all modern JavaScript/TypeScript extensions', () => {
      for (const ext of supportedExtensions) {
        const hasExtension = PP_DEV_CONFIG_NAMES.some((name) => name.endsWith(ext));
        expect(hasExtension, `Should support ${ext} extension`).toBe(true);
      }
    });
  });
});
