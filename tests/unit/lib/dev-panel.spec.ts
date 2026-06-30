import { describe, it, expect, vi } from 'vitest';

// Stub the bundled panel template so the test does not depend on build artifacts.
// Only the panel template read is overridden; everything else (e.g. constants.ts
// reading package.json) keeps the real implementation.
const TEMPLATE = '<div class="pp-dev-info" data-version="{%= VERSION %}">{%= PACKAGE_NAME %}</div>';

vi.mock('fs', async (importActual) => {
  const actual = await importActual<typeof import('fs')>();

  return {
    ...actual,
    readFileSync: (p: any, ...rest: any[]) => {
      if (typeof p === 'string' && p.endsWith('index.html')) {
        return TEMPLATE;
      }

      return (actual.readFileSync as any)(p, ...rest);
    },
  };
});

const { getDevPanelAssetPaths, injectDevPanel } = await import('../../../src/lib/dev-panel.js');

describe('dev-panel', () => {
  describe('getDevPanelAssetPaths', () => {
    it('builds asset URLs under the base path', () => {
      const { css, js } = getDevPanelAssetPaths('/p/my-app/');

      expect(js).toBe('/p/my-app/@metricinsights/pp-dev/client/client.js');
      expect(css).toBe('/p/my-app/@metricinsights/pp-dev/client/client.css');
    });
  });

  describe('injectDevPanel', () => {
    const baseHtml = '<html><head><title>x</title></head><body><main>app</main></body></html>';

    it('injects the stylesheet into <head> and panel + script into <body>', () => {
      const out = injectDevPanel(baseHtml, '/p/my-app/', {
        templateLess: false,
        backendBaseURL: 'http://mi',
        appId: 1,
      });

      expect(out).toContain('<link rel="stylesheet" href="/p/my-app/@metricinsights/pp-dev/client/client.css">');
      expect(out).toContain('class="pp-dev-info"');
      expect(out).toContain('<script type="module" src="/p/my-app/@metricinsights/pp-dev/client/client.js"></script>');
    });

    it('places the stylesheet before the panel markup', () => {
      const out = injectDevPanel(baseHtml, '/p/my-app/', { templateLess: false });

      expect(out.indexOf('client.css')).toBeLessThan(out.indexOf('pp-dev-info'));
    });

    it('injects the panel right after the opening <body> tag', () => {
      const out = injectDevPanel(baseHtml, '/p/my-app/', { templateLess: false });

      expect(out).toMatch(/<body[^>]*><div class="pp-dev-info"/);
    });

    it('returns non-HTML content unchanged', () => {
      const json = '{"data":true}';

      expect(injectDevPanel(json, '/p/my-app/', { templateLess: false })).toBe(json);
    });
  });
});
