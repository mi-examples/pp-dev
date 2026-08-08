import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { INSPECTOR_PATH, registerInspectorRoutes } from '../../../src/lib/request-inspector.js';
import { RequestStore } from '../../../src/lib/request-store.js';

function makeApp() {
  const handlers = new Map<string, (req: any, res: any) => any>();

  const app = {
    handlers,
    get(path: string, handler: (req: any, res: any) => any) {
      handlers.set(`GET ${path}`, handler);
    },
    delete(path: string, handler: (req: any, res: any) => any) {
      handlers.set(`DELETE ${path}`, handler);
    },
  };

  return app as unknown as import('express').Application & { handlers: typeof handlers };
}

function getInspectorHtml(): string {
  const app = makeApp();
  const res: any = {
    body: '',
    setHeader() {},
    end(body: string) {
      res.body = body;
    },
  };

  registerInspectorRoutes(app, new RequestStore());
  app.handlers.get(`GET ${INSPECTOR_PATH}`)!({}, res);

  return res.body;
}

function highlightJsonFromGeneratedClient(html: string, input: string): string {
  const start = html.indexOf('function syntaxHighlightJson');
  const end = html.indexOf('function decodeTextBody', start);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  const context = { output: '' };
  const helperSource = html.slice(start, end);

  runInNewContext(`${helperSource}\noutput = syntaxHighlightJson(${JSON.stringify(input)});`, context);

  return context.output;
}

describe('request inspector JSON rendering', () => {
  it('escapes invalid JSON before inserting it into the detail HTML', () => {
    const payload = '</pre><img src=x onerror=alert(1)>';
    const rendered = highlightJsonFromGeneratedClient(getInspectorHtml(), payload);

    expect(rendered).toBe('&lt;/pre&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(rendered).not.toContain('<img');
    expect(rendered).not.toContain('</pre>');
  });
});
