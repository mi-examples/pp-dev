import { describe, it, expect, vi, afterEach } from 'vitest';
import { MiAPI } from '../../../src/lib/pp.middleware.js';
import * as jsdomHelper from '../../../src/lib/helpers/jsdom.helper.js';

/**
 * `buildPage` puts the dev page's content into the MI page template on every HTML request. It used
 * to parse and serialize the template with JSDOM and compile a RegExp per page variable each time.
 */

const TEMPLATE =
  '<!DOCTYPE html><html><head><title>MI</title></head>' +
  '<body><div class="main-side"><p>nav</p><script>last()</script></div></body></html>';

async function makeMi(tags: { name: string; value: string }[], template = TEMPLATE) {
  const mi = new MiAPI('http://mi.example.com', { templateLess: false, appId: 7 });

  vi.spyOn(mi, 'getPageTemplate').mockResolvedValue(template as never);
  vi.spyOn(mi.pageApi, 'get').mockResolvedValue({
    name: 'Sales',
    template: 'tpl',
    tags: JSON.stringify(tags),
  } as never);

  await mi.getPageVariables(7, {});

  return mi;
}

describe('MiAPI.buildPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('puts the content before the last script of the template, with the page title', async () => {
    const mi = await makeMi([]);

    expect(mi.buildPage('<main>app</main>')).toBe(
      '<!DOCTYPE html><html><head><title>Sales</title></head>' +
        '<body><div class="main-side"><p>nav</p><main>app</main><script>last()</script></div></body></html>',
    );
  });

  it('substitutes page variables, also on later builds and after they are reloaded', async () => {
    const mi = await makeMi([
      { name: 'Region', value: 'US' },
      { name: 'a.b', value: 'dot' },
    ]);

    expect(mi.buildPage('[Region] [Region] [a.b] [aXb]')).toContain('US US dot [aXb]');
    expect(mi.buildPage('[Region]')).toContain('<p>nav</p>US<script>');

    vi.spyOn(mi.pageApi, 'get').mockResolvedValue({
      name: 'Sales',
      template: 'tpl',
      tags: JSON.stringify([{ name: 'Region', value: 'EMEA' }]),
    } as never);
    await mi.reloadPageVariables();

    expect(mi.buildPage('[Region]')).toContain('<p>nav</p>EMEA<script>');
  });

  it('keeps `$` sequences in the content as they are', async () => {
    const mi = await makeMi([]);

    expect(mi.buildPage("a $& b $' c $1")).toContain("<p>nav</p>a $& b $' c $1<script>");
  });

  it('renders the template once, and again only when the title changes', async () => {
    const mi = await makeMi([]);
    const getJSDOM = vi.spyOn(jsdomHelper, 'getJSDOM');

    mi.buildPage('one');
    mi.buildPage('two');

    expect(getJSDOM).toHaveBeenCalledTimes(1);

    vi.spyOn(mi.pageApi, 'get').mockResolvedValue({ name: 'Renamed', template: 'tpl', tags: '[]' } as never);
    await mi.reloadPageVariables();

    expect(mi.buildPage('three')).toContain('<title>Renamed</title>');
    expect(getJSDOM).toHaveBeenCalledTimes(2);
  });

  it('serializes the content itself for a page without the MI HUD', async () => {
    const mi = await makeMi([{ name: 'Region', value: 'US' }]);

    expect(mi.buildPage('<p>[Region]</p>', true)).toBe('<html><head></head><body><p>US</p></body></html>');
  });
});
