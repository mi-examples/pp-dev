// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { esc, fileExt, syntaxHighlightJson } from '../../../src/client/request-inspector/format.js';
import {
  renderBodySectionHtml,
  renderListHtml,
  type RequestEntry,
  type RequestSummary,
} from '../../../src/client/request-inspector/render.js';
import { startInspector } from '../../../src/client/request-inspector/inspector.js';

/**
 * The Request Inspector page used to be a template literal: its script ran from inline `onclick`
 * handlers calling functions put on `window`, and the tests could only reach a helper by cutting
 * it out of the generated page and evaluating it. These import the modules instead.
 */

const pageHtml = fs.readFileSync(
  path.resolve(__dirname, '../../../src/client/request-inspector/request-inspector.html'),
  'utf-8',
);

const b64 = (text: string) => Buffer.from(text).toString('base64');

const summaries: RequestSummary[] = [
  { id: '1', method: 'GET', url: '/data/page/1', statusCode: 200, duration: 12, responseSize: 2048, source: 'proxy' },
  { id: '2', method: 'POST', url: '/@api/users', statusCode: 500, duration: 1500, source: 'local', user: 'qa' },
];

const entry: RequestEntry = {
  ...summaries[0]!,
  timestamp: Date.UTC(2026, 9, 29, 10),
  requestHeaders: { accept: 'application/json', 'x-list': ['a', 'b'] },
  requestBody: null,
  requestBodySize: 0,
  requestBodyTruncated: false,
  requestContentType: '',
  responseHeaders: { 'content-type': 'application/json' },
  responseBody: b64('{"ok":true}'),
  responseBodySize: 11,
  responseBodyTruncated: false,
  responseContentType: 'application/json',
};

describe('Request Inspector rendering', () => {
  it('escapes invalid JSON instead of highlighting it', () => {
    const rendered = syntaxHighlightJson('</pre><img src=x onerror=alert(1)>');

    expect(rendered).toBe('&lt;/pre&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  it('highlights valid JSON', () => {
    expect(syntaxHighlightJson('{"a":1,"b":null}')).toBe(
      '{\n  <span class="body-json-key">&quot;a&quot;:</span> <span class="body-json-num">1</span>,\n' +
        '  <span class="body-json-key">&quot;b&quot;:</span> <span class="body-json-null">null</span>\n}',
    );
  });

  it('lists requests with their id for the click handler, and no inline handlers', () => {
    const html = renderListHtml([{ ...summaries[0]!, url: '/x?a="<b>"' }], '1');

    expect(html).toContain('data-id="1"');
    expect(html).toContain('req-item src-proxy selected');
    expect(html).toContain('/x?a=&quot;&lt;b&gt;&quot;');
    expect(html).not.toMatch(/\son[a-z]+=/);
  });

  it("names a body section's buttons by what they do", () => {
    const html = renderBodySectionHtml('Response Body', b64('{}'), 'application/json', false, 2, 'response', 1024);

    expect(html).toContain('data-action="copy-body" data-type="response"');
    expect(html).toContain('data-action="save-body" data-type="response"');
    expect(html).toContain('data-action="toggle-section"');
  });

  it('notes a body over the capture limit', () => {
    expect(renderBodySectionHtml('Request Body', null, 'text/plain', true, 99, 'request', 10 * 1024 * 1024)).toContain(
      'larger than the capture limit (10.0 MB)',
    );
  });

  it('names saved bodies by their content type', () => {
    expect(fileExt('application/json; charset=utf-8')).toBe('json');
    expect(fileExt(undefined)).toBe('bin');
    expect(esc('"<&>')).toBe('&quot;&lt;&amp;&gt;');
  });
});

describe('Request Inspector page', () => {
  let stop: () => void;
  let fetchMock: ReturnType<typeof vi.fn>;
  let writeText: ReturnType<typeof vi.fn>;

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const click = (el: Element | null) => (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const $ = (selector: string) => document.querySelector(selector);

  beforeEach(async () => {
    const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(pageHtml)![1]!;

    document.body.innerHTML = body;
    document.body.dataset.captureLimit = '2048';
    localStorage.clear();
    document.documentElement.removeAttribute('data-pp-dev-theme');

    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return new Response('{"ok":true}');
      }

      if (url === '/@api/requests') {
        return new Response(JSON.stringify({ requests: summaries, total: 2, memoryUsage: 512, maxMemory: 1024 }));
      }

      return new Response(JSON.stringify(entry));
    });
    vi.stubGlobal('fetch', fetchMock);
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    stop = startInspector({ pollIntervalMs: 60_000 });
    await flush();
  });

  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
  });

  it('lists the requests and the stats', () => {
    expect(document.querySelectorAll('.req-item')).toHaveLength(2);
    expect($('#req-count')!.textContent).toBe('2 requests');
    expect($('#mem-text')!.textContent).toBe('512 B / 1.0 KB');
    // A request was sent as a saved user, so the user filter shows.
    expect(($('#user-select') as HTMLSelectElement).style.display).toBe('');
  });

  it('filters the list', () => {
    const search = $('#search-input') as HTMLInputElement;

    search.value = '@api';
    search.dispatchEvent(new Event('input', { bubbles: true }));

    expect(Array.from(document.querySelectorAll('.req-item')).map((el) => (el as HTMLElement).dataset.id)).toEqual([
      '2',
    ]);

    const user = $('#user-select') as HTMLSelectElement;

    search.value = '';
    user.value = '@original';
    user.dispatchEvent(new Event('change', { bubbles: true }));

    expect(Array.from(document.querySelectorAll('.req-item')).map((el) => (el as HTMLElement).dataset.id)).toEqual([
      '1',
    ]);
  });

  it('shows a request when its row is clicked', async () => {
    click($('.req-item[data-id="1"] .req-url'));
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/@api/requests/1');
    expect(($('#detail-panel') as HTMLElement).style.display).toBe('flex');
    expect($('#detail-url')!.textContent).toContain('/data/page/1');
    expect($('#detail-scroll .body-json-key')!.textContent).toBe('"ok":');
    expect($('.req-item[data-id="1"]')!.classList.contains('selected')).toBe(true);
  });

  it("collapses a section from its header, but not from the header's buttons", async () => {
    click($('.req-item[data-id="1"]'));
    await flush();

    const header = $('#detail-scroll .detail-section-hdr')!;

    click(header.querySelector('[data-action="copy-headers"]'));
    await flush();

    expect(writeText).toHaveBeenCalledWith('accept: application/json\nx-list: a, b');
    expect(header.nextElementSibling!.classList.contains('collapsed')).toBe(false);

    click(header.querySelector('.section-title'));

    expect(header.nextElementSibling!.classList.contains('collapsed')).toBe(true);
    expect(header.querySelector('.toggle')!.textContent).toBe('▸');
  });

  it('copies the URL and the response body', async () => {
    click($('.req-item[data-id="1"]'));
    await flush();
    click($('[data-action="copy-url"]'));
    click($('[data-action="copy-body"][data-type="response"]'));

    expect(writeText).toHaveBeenNthCalledWith(1, '/data/page/1');
    expect(writeText).toHaveBeenNthCalledWith(2, '{"ok":true}');
  });

  it('clears the requests', async () => {
    click($('[data-action="clear"]'));
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/@api/requests', { method: 'DELETE' });
    expect(document.querySelectorAll('.req-item')).toHaveLength(0);
    expect($('#req-count')!.textContent).toBe('0 requests');
  });

  it('switches the theme and remembers it', () => {
    click($('[data-theme-choice="dark"]'));

    expect(document.documentElement.getAttribute('data-pp-dev-theme')).toBe('dark');
    expect(localStorage.getItem('pp-dev-info-theme')).toBe('dark');
    expect($('[data-theme-choice="dark"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('stops listening once stopped', () => {
    stop();
    fetchMock.mockClear();
    click($('.req-item[data-id="1"]'));

    expect(fetchMock).not.toHaveBeenCalled();

    stop = () => {};
  });
});
