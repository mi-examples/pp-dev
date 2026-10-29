import { describe, it, expect, vi } from 'vitest';

// Stub the bundled panel template so the test does not depend on build artifacts.
// Only the panel template read is overridden; everything else (e.g. constants.ts
// reading package.json) keeps the real implementation.
const TEMPLATE =
  '<div class="pp-dev-info pp-dev-info--{%= devPanelPosition %}" data-version="{%= VERSION %}" data-position="{%= devPanelPosition %}" data-auto-hide="{%= devPanelAutoHide %}" data-hidden="{%= devPanelHidden %}">{%= PACKAGE_NAME %}</div>';

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

const { getDevPanelAssetPaths, injectDevPanel, renderDevPanelMarkup } = await import('../../../src/lib/dev-panel.js');

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
      expect(out).toContain('class="pp-dev-info');
      expect(out).toContain('<script type="module" src="/p/my-app/@metricinsights/pp-dev/client/client.js"></script>');
    });

    it('renders devPanel defaults when fields are omitted (EJS with(locals) regression guard)', () => {
      const out = injectDevPanel(baseHtml, '/p/my-app/', { templateLess: false });

      expect(out).toContain('pp-dev-info--bottom-right');
      expect(out).toContain('data-position="bottom-right"');
      expect(out).toContain('data-auto-hide="false"');
      expect(out).toContain('data-hidden="false"');
    });

    it('passes explicit devPanel values through to the template', () => {
      const out = injectDevPanel(baseHtml, '/p/my-app/', {
        templateLess: false,
        devPanelPosition: 'top-left',
        devPanelHidden: true,
        devPanelAutoHide: true,
      });

      expect(out).toContain('pp-dev-info--top-left');
      expect(out).toContain('data-position="top-left"');
      expect(out).toContain('data-auto-hide="true"');
      expect(out).toContain('data-hidden="true"');
    });

    it('places the stylesheet before the panel markup', () => {
      const out = injectDevPanel(baseHtml, '/p/my-app/', { templateLess: false });

      expect(out.indexOf('client.css')).toBeLessThan(out.indexOf('pp-dev-info'));
    });

    it('injects the panel right after the opening <body> tag', () => {
      const out = injectDevPanel(baseHtml, '/p/my-app/', { templateLess: false });

      expect(out).toMatch(/<body[^>]*><div class="pp-dev-info/);
    });

    it('returns non-HTML content unchanged', () => {
      const json = '{"data":true}';

      expect(injectDevPanel(json, '/p/my-app/', { templateLess: false })).toBe(json);
    });

    // As a replacement string, `$&` in the inserted markup (here from the base path) expanded into
    // the matched `</head>` / `<body>`.
    it('inserts `$` sequences as they are', () => {
      const out = injectDevPanel(baseHtml, "/p/a$&b$'c/", { templateLess: false });

      expect(out).toContain(
        `<link rel="stylesheet" href="/p/a$&b$'c/@metricinsights/pp-dev/client/client.css"></head>`,
      );
      expect(out).toContain(`<script type="module" src="/p/a$&b$'c/@metricinsights/pp-dev/client/client.js"></script>`);
      expect(out.match(/<\/head>/g)).toHaveLength(1);
      expect(out.match(/<body>/g)).toHaveLength(1);
    });
  });

  // The Vite plugin compiled the same template a second time, with its own copy of the defaults.
  describe('clientInjectionPlugin', () => {
    it('injects the same panel markup as `pp-dev next`, with the same defaults', async () => {
      const { clientInjectionPlugin } = await import('../../../src/plugins/client-injection-plugin.js');
      const opts = { templateLess: false, devPanelPosition: 'top-left' as const };
      const plugin = clientInjectionPlugin(opts);
      const transform = plugin.transformIndexHtml as (
        html: string,
        ctx: object,
      ) => Promise<{
        tags: { tag: string; children?: string }[];
      }>;

      const { tags } = await transform(baseHtmlForPlugin, { server: { config: { base: '/p/my-app/' } } });
      const panel = tags.find((tag) => tag.tag === 'div')?.children;

      expect(panel).toBe(renderDevPanelMarkup(opts));
      expect(panel).toContain('data-hidden="false"');
    });
  });
});

const baseHtmlForPlugin = '<html><head></head><body></body></html>';
