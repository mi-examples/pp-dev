// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VARIABLES_EDITOR_PATH } from '../../../src/lib/variables-editor.js';
import { startVariablesEditor } from '../../../src/client/variables-editor/editor.js';

/**
 * The Variables Editor page, driven the way a browser tab would: the page's markup, its script
 * started by startVariablesEditor(), `fetch` stubbed, and the user's clicks and typing dispatched
 * on the page's own controls. These ran the script cut out of the server's template literal with
 * `eval` in a JSDOM before it moved to src/client.
 */

const PAGE_HTML = fs.readFileSync(
  path.resolve(__dirname, '../../../src/client/variables-editor/variables-editor.html'),
  'utf-8',
);

/** The page at `url` (its markup and address); `start()` runs its script, `close()` stops it. */
function openEditorPage(url: string, { templateLess = false } = {}) {
  const html = PAGE_HTML.replace('{{templateLess}}', String(templateLess));

  // jsdom has no layout, so no scrollIntoView; the Values tab scrolls to the selected variable.
  Element.prototype.scrollIntoView ??= () => {};

  document.documentElement.innerHTML = /<html[^>]*>([\s\S]*)<\/html>/.exec(html)![1]!;
  history.replaceState(null, '', new URL(url).pathname + new URL(url).search);

  let stop = () => {};

  return {
    window: window as unknown as Window & typeof globalThis,
    start() {
      stop = startVariablesEditor({ templateLess });
    },
    close() {
      stop();
      vi.unstubAllGlobals();
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function find<T extends HTMLElement = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);

  if (!el) {
    throw new Error(`Nothing matches ${selector}`);
  }

  return el;
}

/** A click on the control (bubbling, as a user's). */
const click = (target: string | HTMLElement) => (typeof target === 'string' ? find(target) : target).click();

/** What typing (`input`) or picking (`change`) does to a field: its new value, and the event. */
function enter(
  target: string | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  type: 'input' | 'change' = 'input',
) {
  const el = typeof target === 'string' ? find<HTMLInputElement>(target) : target;

  el.value = value;
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

/** A drag event as the browser fires it, with the `dataTransfer` the handlers write to. */
function drag(el: Element, type: string, relatedTarget: Element | null = null) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget });

  Object.defineProperty(event, 'dataTransfer', {
    value: { effectAllowed: '', dropEffect: '', setData: vi.fn() },
  });
  el.dispatchEvent(event);

  return event;
}

const banner = () => document.querySelector('#content > .banner')?.textContent ?? '';

describe('Variables Editor page', () => {
  it('keeps the newest values response when overlapping loads resolve out of order', async () => {
    const dom = openEditorPage(`http://localhost${VARIABLES_EDITOR_PATH}?tab=values`);
    const pending: Array<(response: { ok: boolean; json: () => Promise<unknown> }) => void> = [];
    const fetch = vi.fn(
      () =>
        new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
          pending.push(resolve);
        }),
    );

    vi.stubGlobal('fetch', fetch);

    dom.start();
    expect(fetch).toHaveBeenCalledTimes(1);

    click('[data-action="refresh"]');
    expect(fetch).toHaveBeenCalledTimes(2);

    pending[1]!({
      ok: true,
      json: async () => ({ schema: null, live: [], combined: [{ name: 'title', value: 'newer' }] }),
    });
    await flush();

    pending[0]!({
      ok: true,
      json: async () => ({ schema: null, live: [], combined: [{ name: 'title', value: 'older' }] }),
    });
    await flush();

    const valueInput = dom.window.document.querySelector<HTMLInputElement>('#content .ve-values-detail input');

    expect(valueInput?.value).toBe('newer');

    dom.close();
  });

  it('shows an error banner instead of hanging when the initial values fetch rejects', async () => {
    const dom = openEditorPage(`http://localhost${VARIABLES_EDITOR_PATH}?tab=values`);
    const fetch = vi.fn().mockRejectedValue(new Error('network down'));

    vi.stubGlobal('fetch', fetch);

    dom.start();
    await flush();

    expect(dom.window.document.querySelector('#content > .banner')?.textContent).toContain(
      'Failed to load values: network down',
    );

    dom.close();
  });

  it('offers to update the local pages while they show other values than MI', async () => {
    const dom = openEditorPage(`http://localhost${VARIABLES_EDITOR_PATH}?tab=values`);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          schema: null,
          live: [
            { name: 'Region', value: 'EMEA' },
            { name: 'Limit', value: '50' },
          ],
          combined: [
            { name: 'Region', value: 'EMEA' },
            { name: 'Limit', value: '50' },
          ],
          local: [
            { name: 'Region', value: 'US' },
            { name: 'Limit', value: '50' },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          local: [
            { name: 'Region', value: 'EMEA' },
            { name: 'Limit', value: '50' },
          ],
        }),
      });

    vi.stubGlobal('fetch', fetch);

    dom.start();
    await flush();

    const button = dom.window.document.getElementById('local-update-btn') as HTMLButtonElement;

    expect(button.hidden).toBe(false);
    expect(button.textContent).toBe('Update local pages · 1');
    expect(button.title).toContain('Region: US → EMEA');
    expect(button.title).not.toContain('Limit');

    click(button);
    await flush();

    expect(fetch).toHaveBeenLastCalledWith('/@api/variables/values/local', { method: 'POST' });
    expect(button.hidden).toBe(true);
    expect(dom.window.document.querySelector('#content > .banner')?.textContent).toContain('Local pages updated');

    dom.close();
  });

  async function openValuesTab(responses: unknown[], mode = '') {
    const dom = openEditorPage(`http://localhost${VARIABLES_EDITOR_PATH}?tab=values${mode}`);
    const fetch = vi.fn();

    for (const body of responses) {
      fetch.mockResolvedValueOnce({ ok: true, json: async () => body });
    }

    vi.stubGlobal('fetch', fetch);

    dom.start();
    await flush();

    const button = dom.window.document.getElementById('local-update-btn') as HTMLButtonElement;
    const update = async () => {
      click(button);
      await flush();
    };

    return { dom, fetch, button, update };
  }

  it("renders a variable's description as markdown", async () => {
    const { dom } = await openValuesTab([
      {
        schema: { tags: [{ name: 'Region', description: '**Pick** one of `EMEA`, <u>US</u>' }] },
        live: [{ name: 'Region', value: 'EMEA' }],
        combined: [{ name: 'Region', value: 'EMEA' }],
        local: [{ name: 'Region', value: 'EMEA' }],
      },
    ]);
    const hint = dom.window.document.querySelector('#content .ve-md');

    expect(hint?.innerHTML).toBe('<p><strong>Pick</strong> one of <code>EMEA</code>, <u>US</u></p>');

    dom.close();
  });

  it('tells a missing variable from an empty one', async () => {
    const { dom, button } = await openValuesTab([
      { schema: null, live: [{ name: 'Note', value: '' }], combined: [{ name: 'Note', value: '' }], local: [] },
    ]);

    expect(button.hidden).toBe(false);
    expect(button.title).toContain('Note: (missing) → (empty)');

    dom.close();
  });

  it("takes the reloaded values for MI's latest, so a change in MI meanwhile doesn't keep the button", async () => {
    const { dom, button, update } = await openValuesTab([
      {
        schema: null,
        live: [{ name: 'Region', value: 'EMEA' }],
        combined: [{ name: 'Region', value: 'EMEA' }],
        local: [{ name: 'Region', value: 'US' }],
      },
      // MI changed to APAC after the tab loaded.
      { local: [{ name: 'Region', value: 'APAC' }] },
    ]);

    await update();

    expect(button.hidden).toBe(true);

    dom.close();
  });

  it('keeps an unsaved raw JSON draft when updating the local pages', async () => {
    const { dom, update } = await openValuesTab(
      [
        {
          schema: null,
          live: [{ name: 'Region', value: 'EMEA' }],
          combined: [{ name: 'Region', value: 'EMEA' }],
          local: [{ name: 'Region', value: 'US' }],
        },
        { local: [{ name: 'Region', value: 'EMEA' }] },
      ],
      '&mode=json',
    );
    const editor = () => dom.window.document.getElementById('values-raw-editor') as HTMLTextAreaElement;

    editor().value = '[{"name":"Region","value":"draft"}]';
    await update();

    expect(editor().value).toBe('[{"name":"Region","value":"draft"}]');

    dom.close();
  });

  it('shows only the message on a page without a template', () => {
    const dom = openEditorPage(`http://localhost${VARIABLES_EDITOR_PATH}`, { templateLess: true });
    const fetch = vi.fn();

    vi.stubGlobal('fetch', fetch);
    dom.start();

    expect(document.body.dataset.templateLess).toBe('true');
    expect(document.getElementById('content')!.textContent).toContain('no associated template');
    expect(fetch).not.toHaveBeenCalled();

    dom.close();
  });

  it('switches the theme from the toolbar, also on a page without a template', () => {
    const dom = openEditorPage(`http://localhost${VARIABLES_EDITOR_PATH}`, { templateLess: true });

    vi.stubGlobal('fetch', vi.fn());
    dom.start();

    click('[data-theme-choice="dark"]');

    expect(document.documentElement.getAttribute('data-pp-dev-theme')).toBe('dark');
    expect(localStorage.getItem('pp-dev-info-theme')).toBe('dark');
    expect(find('[data-theme-choice="dark"]').getAttribute('aria-pressed')).toBe('true');
    expect(find('[data-theme-choice="auto"]').getAttribute('aria-pressed')).toBe('false');

    click('[data-theme-choice="auto"]');

    expect(document.documentElement.hasAttribute('data-pp-dev-theme')).toBe(false);

    dom.close();
    localStorage.clear();
  });

  // The name pattern lived in the template literal, where `\s` had to be written `\\s`: a single
  // backslash turned it into a plain `s`, and every name with a space got the warning.
  it('accepts whitespace in variable names, but not other characters MI rejects', async () => {
    const dom = openEditorPage(`http://localhost${VARIABLES_EDITOR_PATH}?tab=schema`);
    const tag = (name: string) => ({ name, tag_source: 'static', tag_type: 'text', additional_options: '' });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          exists: true,
          raw: '{"tags":[]}',
          schema: { tags: [tag('Connection Report Meta'), tag('bad$name')] },
        }),
      }),
    );
    dom.start();
    await flush();

    const warnings = document.body.textContent!.match(/Contains a character MI's own editor doesn't allow/g) ?? [];

    expect(warnings).toHaveLength(1);

    dom.close();
  });

  // The title was escaped by the caller and again by showInfoModal(): `&` showed as `&amp;`.
  it('shows the additional_options help title escaped once', async () => {
    const dom = openEditorPage(`http://localhost${VARIABLES_EDITOR_PATH}?tab=schema`);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          exists: true,
          raw: '{"tags":[]}',
          schema: { tags: [{ name: 'v', tag_type: 'a&b', tag_source: '<src>', additional_options: '' }] },
        }),
      }),
    );
    dom.start();
    await flush();

    click('[data-action="show-additional-options-help"][data-index="0"]');

    expect(document.querySelector('.ve-modal-title')!.textContent).toBe('additional_options — a&b / <src>');

    dom.close();
  });

  it('does not save malformed additional_options text as a string', async () => {
    const dom = openEditorPage(`http://localhost${VARIABLES_EDITOR_PATH}?tab=schema`);
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        exists: true,
        raw: '{"tags":[]}',
        schema: {
          tags: [{ additional_options: [], name: 'choice', tag_source: 'static', tag_type: 'select' }],
        },
      }),
    });

    vi.stubGlobal('fetch', fetch);

    dom.start();
    await flush();

    enter('#ao-raw-0', 'not valid JSON');
    click('#save-btn');
    await flush();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(dom.window.document.querySelector('#content > .banner')?.textContent).toContain(
      'additional_options must be valid JSON',
    );

    dom.close();
  });

  it('preserves value edits made while a save request is pending', async () => {
    const dom = openEditorPage(`http://localhost${VARIABLES_EDITOR_PATH}?tab=values`);
    const pending: Array<(response: { ok: boolean; json: () => Promise<unknown> }) => void> = [];
    const fetch = vi.fn(
      () =>
        new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
          pending.push(resolve);
        }),
    );

    vi.stubGlobal('fetch', fetch);

    dom.start();
    pending[0]!({
      ok: true,
      json: async () => ({ schema: null, live: [], combined: [{ name: 'title', value: 'initial' }] }),
    });
    await flush();

    const valueInputBeforeSave = dom.window.document.querySelector<HTMLInputElement>(
      '#content .ve-values-detail input',
    )!;

    enter(valueInputBeforeSave, 'submitted');
    click('#save-btn');
    // Save opens a confirmation diff modal instead of saving immediately — confirm it.
    click('.ve-modal-ok');
    expect(fetch).toHaveBeenCalledTimes(2);

    enter(valueInputBeforeSave, 'newer unsaved edit');
    pending[1]!({ ok: true, json: async () => ({ ok: true, warnings: [] }) });
    await flush();

    if (pending[2]) {
      pending[2]({
        ok: true,
        json: async () => ({ schema: null, live: [], combined: [{ name: 'title', value: 'submitted' }] }),
      });
      await flush();
    }

    const valueInput = dom.window.document.querySelector<HTMLInputElement>('#content .ve-values-detail input');

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(valueInput?.value).toBe('newer unsaved edit');
    expect(dom.window.document.querySelector('#content > .banner')?.textContent).toContain(
      'Newer edits remain unsaved.',
    );

    click('[data-action="refresh"]');
    expect(dom.window.document.querySelector('.ve-modal-title')?.textContent).toBe('Discard unsaved changes?');

    dom.close();
  });

  it('handles each event once after being stopped and started again in the same document', async () => {
    const first = openEditorPage(`http://localhost${VARIABLES_EDITOR_PATH}?tab=values`);
    const valuesResponse = { ok: true, json: async () => ({ schema: null, live: [], combined: [] }) };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(valuesResponse));
    first.start();
    await flush();
    first.close();

    const dom = openEditorPage(`http://localhost${VARIABLES_EDITOR_PATH}?tab=values`);
    const fetch = vi.fn().mockResolvedValue(valuesResponse);

    vi.stubGlobal('fetch', fetch);
    dom.start();
    await flush();

    click('[data-action="refresh"]');
    await flush();

    expect(fetch).toHaveBeenCalledTimes(2);

    dom.close();
  });

  describe('client: failed loads and saves', () => {
    type FetchResponse = { ok: boolean; status?: number; statusText?: string; json: () => Promise<unknown> };

    const htmlErrorPage = (status: number, statusText: string): FetchResponse => ({
      ok: false,
      status,
      statusText,
      json: async () => {
        throw new SyntaxError('Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON');
      },
    });

    async function openEditor(tab: 'schema' | 'values', fetch: ReturnType<typeof vi.fn>) {
      const dom = openEditorPage(`http://localhost${VARIABLES_EDITOR_PATH}?tab=${tab}`);

      vi.stubGlobal('fetch', fetch);

      dom.start();
      await flush();

      const confirmSave = async () => {
        click('#save-btn');
        click('.ve-modal-ok');
        await flush();
      };
      const asksToDiscard = () => {
        click('[data-action="refresh"]');

        const asked = dom.window.document.querySelector('.ve-modal-title')?.textContent === 'Discard unsaved changes?';

        dom.window.document.querySelector<HTMLButtonElement>('.ve-modal-cancel')?.click();

        return asked;
      };

      return { dom, confirmSave, asksToDiscard };
    }

    const schemaResponse: FetchResponse = {
      ok: true,
      json: async () => ({ exists: true, raw: '{"tags":[{"name":"title"}]}', schema: { tags: [{ name: 'title' }] } }),
    };

    const valuesResponse: FetchResponse = {
      ok: true,
      json: async () => ({ schema: null, live: [], combined: [{ name: 'title', value: 'initial' }] }),
    };

    it('shows why a schema save failed on an HTML error page, keeping the raw draft and the unsaved state', async () => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(schemaResponse)
        .mockResolvedValueOnce(htmlErrorPage(500, 'Internal Server Error'));
      const { dom, confirmSave, asksToDiscard } = await openEditor('schema', fetch);
      const draft = '{"tags":[{"name":"title"},{"name":"subtitle"}]}';

      click('[data-action="toggle-raw-mode"]');
      enter('#raw-editor', draft);
      await confirmSave();

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(banner()).toContain('Save failed: the dev server answered HTTP 500 Internal Server Error');
      expect(dom.window.document.querySelector<HTMLTextAreaElement>('#raw-editor')!.value).toBe(draft);
      expect(asksToDiscard()).toBe(true);

      dom.close();
    });

    it("shows the server's error for a values save over the body limit, keeping the raw draft", async () => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(valuesResponse)
        .mockResolvedValueOnce({
          ok: false,
          status: 413,
          statusText: 'Payload Too Large',
          json: async () => ({ error: 'The request body is larger than the dev server accepts (10mb).' }),
        });
      const { dom, confirmSave, asksToDiscard } = await openEditor('values', fetch);
      const draft = '[{"name":"title","value":"edited"}]';

      click('[data-action="toggle-values-raw-mode"]');
      enter('#values-raw-editor', draft);
      await confirmSave();

      expect(banner()).toContain('Save failed: The request body is larger than the dev server accepts (10mb).');
      expect(dom.window.document.querySelector<HTMLTextAreaElement>('#values-raw-editor')!.value).toBe(draft);
      expect(asksToDiscard()).toBe(true);

      dom.close();
    });

    it("shows the server's details when MI rejects a values save", async () => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(valuesResponse)
        .mockResolvedValueOnce({
          ok: false,
          status: 502,
          statusText: 'Bad Gateway',
          json: async () => ({
            error: 'Failed to save live page variables.',
            details: 'Request failed with status 500',
          }),
        });
      const { dom, confirmSave } = await openEditor('values', fetch);

      enter('#content .ve-values-detail input', 'edited');
      await confirmSave();

      expect(banner()).toContain('Save failed: Failed to save live page variables. Request failed with status 500');

      dom.close();
    });

    it('shows a network failure of a save instead of leaving it pending', async () => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(valuesResponse)
        .mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const { dom, confirmSave, asksToDiscard } = await openEditor('values', fetch);

      enter('#content .ve-values-detail input', 'edited');
      await confirmSave();

      expect(banner()).toContain('Save failed: Failed to fetch');
      expect(asksToDiscard()).toBe(true);

      dom.close();
    });

    it('treats a 2xx answer that is not JSON as a failed save', async () => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(valuesResponse)
        .mockResolvedValueOnce({ ...htmlErrorPage(200, 'OK'), ok: true });
      const { dom, confirmSave, asksToDiscard } = await openEditor('values', fetch);

      enter('#content .ve-values-detail input', 'edited');
      await confirmSave();

      expect(banner()).toContain('Save failed: the dev server sent an answer that is not JSON');
      expect(asksToDiscard()).toBe(true);

      dom.close();
    });

    it('shows a failed schema load as an error, not as a missing file', async () => {
      const fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => ({ error: 'Dist service or MiAPI is not defined' }),
      });
      const { dom } = await openEditor('schema', fetch);

      expect(banner()).toContain('Failed to load the schema: Dist service or MiAPI is not defined');
      expect(dom.window.document.querySelector('#content')?.textContent).not.toContain(
        'No local __template_variables.json found',
      );

      click('#save-btn');
      await flush();

      expect(banner()).toContain('Cannot save the schema until it has loaded successfully.');
      expect(fetch).toHaveBeenCalledTimes(1);

      dom.close();
    });
  });

  describe('client: schema tab controls', () => {
    const tag = (name: string, extra: Record<string, unknown> = {}) => ({
      name,
      uid: 'uid-' + name,
      tag_type: 'text',
      tag_source: 'static',
      additional_options: '',
      ...extra,
    });

    async function openSchemaTab(tags: unknown[]) {
      const dom = openEditorPage(`http://localhost${VARIABLES_EDITOR_PATH}?tab=schema`);
      const fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ exists: true, raw: JSON.stringify({ tags }), schema: { tags } }),
      });

      vi.stubGlobal('fetch', fetch);
      dom.start();
      await flush();

      return dom;
    }

    const names = () =>
      Array.from(document.querySelectorAll<HTMLInputElement>('tr.schema-row .col-name input')).map((i) => i.value);

    /** The tags the editor would save, read from its raw JSON view. */
    const rawTags = () => {
      click('[data-action="toggle-raw-mode"]');

      return (JSON.parse(find<HTMLTextAreaElement>('#raw-editor').value) as { tags: Record<string, unknown>[] }).tags;
    };

    it('reorders variables by dragging a row onto another', async () => {
      const dom = await openSchemaTab([tag('a'), tag('b'), tag('c')]);

      drag(find('tr.schema-row[data-row-index="0"] .ve-schema-row-handle'), 'dragstart');

      expect(find('tr.schema-row[data-row-index="0"]').classList.contains('is-dragging')).toBe(true);
      expect(drag(find('tr.schema-row[data-row-index="2"] .col-type'), 'dragover').defaultPrevented).toBe(true);
      expect(find('tr.schema-row[data-row-index="2"]').classList.contains('is-drop-target')).toBe(true);

      drag(find('tr.schema-row[data-row-index="2"] .col-type'), 'drop');

      expect(names()).toEqual(['b', 'c', 'a']);
      expect(document.querySelector('.is-drop-target')).toBeNull();

      drag(find('tr.schema-row[data-row-index="2"] .ve-schema-row-handle'), 'dragend');
      click('[data-action="refresh"]');

      expect(document.querySelector('.ve-modal-title')?.textContent).toBe('Discard unsaved changes?');

      dom.close();
    });

    it("drops a dragged row on a list column card of another row's open details", async () => {
      const dom = await openSchemaTab([
        tag('a'),
        tag('items', { tag_type: 'list', additional_options: [{ name: 'x', type: 'textarea' }] }),
      ]);

      click('[data-action="toggle-schema-advanced"][data-index="1"]');

      expect(find('#advanced-1').style.display).toBe('');

      drag(find('tr.schema-row[data-row-index="0"] .ve-schema-row-handle'), 'dragstart');

      const card = find('#advanced-1 .ve-ao-column');

      expect(drag(card.querySelector('input')!, 'dragover').defaultPrevented).toBe(true);
      expect(find('#advanced-1').classList.contains('is-drop-target')).toBe(true);

      drag(card.querySelector('input')!, 'drop');

      expect(names()).toEqual(['items', 'a']);
      // The moved row's details stay open, now under its new index.
      expect(find('#advanced-0').style.display).toBe('');
      expect(find('#advanced-1').style.display).toBe('none');

      dom.close();
    });

    it('edits, adds, reorders and removes the columns of a list variable', async () => {
      const dom = await openSchemaTab([
        tag('items', {
          tag_type: 'list',
          additional_options: [
            { name: 'x', type: 'textarea' },
            { name: 'y', type: 'color' },
          ],
        }),
      ]);

      click('[data-action="add-list-column"][data-index="0"]');
      enter('[data-action="list-column-name"][data-col="2"]', 'z');
      enter('[data-action="list-column-field"][data-col="2"][data-field="type"]', 'select', 'change');
      enter('[data-action="list-column-options"][data-col="2"]', 'one, two');

      const columns = () => find<HTMLElement>('#advanced-0').querySelectorAll<HTMLElement>('.ve-ao-column');

      drag(columns()[2].querySelector('.ve-ao-column-handle')!, 'dragstart');
      drag(columns()[0], 'dragover');
      drag(columns()[0], 'drop');
      click('[data-action="remove-list-column"][data-col="2"]');

      expect(rawTags()[0].additional_options).toEqual([
        { name: 'z', type: 'select', options: ['one', 'two'] },
        { name: 'x', type: 'textarea' },
      ]);

      dom.close();
    });

    it('applies a type picked from the select and the editor flags, keeping the details open', async () => {
      const dom = await openSchemaTab([tag('a')]);

      click('[data-action="toggle-schema-advanced"][data-index="0"]');
      enter('[data-action="schema-field"][data-field="description"]', 'About a');

      const flag = find<HTMLInputElement>('[data-action="editor-flag"][data-field="use_hmtl_editor_ind"]');

      flag.checked = true;
      flag.dispatchEvent(new Event('change', { bubbles: true }));

      expect(find('#advanced-0').style.display).toBe('');
      // WYSIWYG hides the Raw HTML and JSON Editor flags, as MI's own form does.
      expect(document.querySelector('[data-action="editor-flag"][data-field="use_raw_html_ind"]')).toBeNull();

      enter('[data-action="custom-select"][data-field="tag_type"]', 'color', 'change');

      expect(find('#advanced-0').style.display).toBe('');
      expect(find<HTMLSelectElement>('[data-action="custom-select"][data-field="tag_type"]').value).toBe('color');
      expect(rawTags()[0]).toMatchObject({
        tag_type: 'color',
        description: 'About a',
        use_hmtl_editor_ind: 'Y',
        use_raw_html_ind: 'N',
        use_json_editor_ind: 'N',
      });

      dom.close();
    });

    it('adds a variable, and removes one once confirmed', async () => {
      const dom = await openSchemaTab([tag('a'), tag('b')]);

      click('[data-action="add-schema-row"]');

      expect(names()).toEqual(['a', 'b', 'new_variable_3']);

      click('[data-action="remove-schema-row"][data-index="0"]');

      expect(find('.ve-modal-title').textContent).toBe('Delete variable "a"? This only takes effect once you Save.');

      click('.ve-modal-ok');

      expect(names()).toEqual(['b', 'new_variable_3']);

      dom.close();
    });
  });

  describe('client: values tab controls', () => {
    async function openValues(tags: unknown[], combined: { name: string; value: string }[]) {
      const dom = openEditorPage(`http://localhost${VARIABLES_EDITOR_PATH}?tab=values`);
      const fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ schema: { tags }, live: combined, combined, local: combined }),
      });

      vi.stubGlobal('fetch', fetch);
      dom.start();
      await flush();

      return { dom, fetch };
    }

    /** The values the editor would save, read from its raw JSON view. */
    const rawValues = () => {
      click('[data-action="toggle-values-raw-mode"]');

      return JSON.parse(find<HTMLTextAreaElement>('#values-raw-editor').value) as { name: string; value: unknown }[];
    };

    const options = [{ id: 'us', text: 'USA' }, 'Canada', { id: 'mx', text: 'Mexico' }];

    it('picks an option of a select from its list, which shows while the input has the focus', async () => {
      const { dom } = await openValues(
        [{ name: 'Country', tag_type: 'select', tag_source: 'static', additional_options: options }],
        [{ name: 'Country', value: '' }],
      );
      const input = find<HTMLInputElement>('.ve-combo-input');
      const list = find('#combo-list-0');

      expect(list.style.display).toBe('none');

      input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

      expect(list.style.display).toBe('');

      enter(input, 'mex');

      expect(Array.from(list.children).map((o) => (o as HTMLElement).style.display)).toEqual(['none', 'none', '']);

      const pick = new MouseEvent('mousedown', { bubbles: true, cancelable: true });

      list.children[2].dispatchEvent(pick);

      // Picked on mousedown, its default prevented so the input keeps the focus until then.
      expect(pick.defaultPrevented).toBe(true);
      expect(input.value).toBe('mx');
      expect(list.style.display).toBe('none');
      expect(rawValues()).toEqual([{ name: 'Country', value: 'mx' }]);

      dom.close();
    });

    it('adds and removes the chips of a multiselect', async () => {
      const { dom } = await openValues(
        [{ name: 'Countries', tag_type: 'multiselect', tag_source: 'static', additional_options: options }],
        [{ name: 'Countries', value: 'us' }],
      );
      const pick = (text: string) =>
        Array.from(document.querySelectorAll('.ve-combo-option'))
          .find((o) => (o as HTMLElement).dataset.text === text)!
          .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

      pick('Canada');
      pick('Mexico');
      pick('Canada');

      const chips = () => Array.from(document.querySelectorAll<HTMLElement>('.ve-chip')).map((c) => c.dataset.id);

      expect(chips()).toEqual(['us', 'Canada', 'mx']);

      const remove = find('.ve-chip[data-id="us"] button');
      const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });

      remove.dispatchEvent(press);
      click(remove);

      expect(press.defaultPrevented).toBe(true);
      expect(chips()).toEqual(['Canada', 'mx']);
      expect(rawValues()).toEqual([{ name: 'Countries', value: 'Canada,mx' }]);

      dom.close();
    });

    it('adds, edits and reorders the items of a list', async () => {
      const columns = [
        { name: 'label', type: 'textarea' },
        { name: 'kind', type: 'select', options: ['a', 'b'] },
      ];
      const { dom } = await openValues(
        [{ name: 'Rows', tag_type: 'list', tag_source: 'static', additional_options: columns }],
        [{ name: 'Rows', value: '[{"label":"first","kind":"a"}]' }],
      );

      click('[data-action="add-list-item"][data-index="0"]');
      enter('[data-action="list-item-field"][data-item="1"][data-column="label"]', 'second');
      enter('[data-action="list-item-select"][data-item="1"][data-column="kind"]', 'b', 'change');

      const items = () => document.querySelectorAll<HTMLElement>('.ve-values-list-item');

      drag(items()[1].querySelector('.ve-values-list-item-handle')!, 'dragstart');
      drag(items()[0], 'dragover');
      drag(items()[0], 'drop');

      expect(rawValues()).toEqual([
        {
          name: 'Rows',
          value: [
            { label: 'second', kind: 'b' },
            { label: 'first', kind: 'a' },
          ],
        },
      ]);

      dom.close();
    });

    it('removes an item of a list, of objects and of plain strings', async () => {
      const { dom } = await openValues(
        [
          {
            name: 'Rows',
            tag_type: 'list',
            tag_source: 'static',
            additional_options: [{ name: 'label', type: 'text' }],
          },
          { name: 'Names', tag_type: 'list', tag_source: 'static', additional_options: '' },
        ],
        [
          { name: 'Rows', value: '[{"label":"first"},{"label":"second"},{"label":"third"}]' },
          { name: 'Names', value: '["ann","bob"]' },
        ],
      );

      click('[data-action="remove-list-item"][data-index="0"][data-item="1"]');

      expect(document.querySelectorAll('.ve-values-list-item[data-value-index="0"]')).toHaveLength(2);

      click('[data-action="select-value-row"][data-value-index="1"]');
      click('[data-action="remove-list-item"][data-index="1"][data-item="0"]');

      expect(rawValues()).toEqual([
        { name: 'Rows', value: [{ label: 'first' }, { label: 'third' }] },
        { name: 'Names', value: ['bob'] },
      ]);

      dom.close();
    });

    it('sets a boolean from its checkbox', async () => {
      const { dom } = await openValues([{ name: 'On', tag_type: 'boolean' }], [{ name: 'On', value: 'false' }]);
      const box = find<HTMLInputElement>('[data-action="value-boolean"]');

      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));

      expect(rawValues()).toEqual([{ name: 'On', value: 'true' }]);

      dom.close();
    });

    it('imports the values picked from another page', async () => {
      const { dom, fetch } = await openValues(
        [{ name: 'Region' }, { name: 'Limit' }],
        [
          { name: 'Region', value: 'EMEA' },
          { name: 'Limit', value: '50' },
        ],
      );

      fetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            pages: [
              { id: 7, name: 'Sales "EU"', internal_name: 'sales-eu', sameTemplate: true },
              { id: 8, name: 'Other', internal_name: 'other', sameTemplate: false },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            importable: [
              { name: 'Region', sourceValue: 'US', tagType: 'text' },
              { name: 'Limit', sourceValue: '10', tagType: 'text' },
            ],
            skipped: [],
          }),
        });

      click('[data-action="open-import-modal"]');
      await flush();

      expect(fetch).toHaveBeenLastCalledWith('/@api/variables/pages');

      enter('#ve-import-filter', 'sales');

      expect(find('[data-page-id="8"]').style.display).toBe('none');

      click('[data-page-id="7"]');
      await flush();

      expect(fetch).toHaveBeenLastCalledWith('/@api/variables/import-plan/7');
      expect(find('#ve-import-overlay .ve-modal-title').textContent).toBe('Import values from "Sales "EU""');

      const limit = find<HTMLInputElement>('.ve-import-check[data-index="1"]');

      limit.checked = false;
      limit.dispatchEvent(new Event('change', { bubbles: true }));

      expect(find('#ve-import-count').textContent).toBe('1 of 2 selected');
      expect(find<HTMLInputElement>('#ve-import-select-all').checked).toBe(false);

      click('#ve-import-apply-btn');

      expect(document.getElementById('ve-import-overlay')).toBeNull();
      expect(banner()).toContain('Imported 1 of 2 variable(s) from "Sales "EU"". Save to apply.');
      expect(rawValues()).toEqual([
        { name: 'Region', value: 'US' },
        { name: 'Limit', value: '50' },
      ]);

      dom.close();
    });
  });
});
