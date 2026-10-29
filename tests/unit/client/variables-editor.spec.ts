// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VARIABLES_EDITOR_PATH } from '../../../src/lib/variables-editor.js';
import { startVariablesEditor } from '../../../src/client/variables-editor/editor.js';

/**
 * The Variables Editor page, driven the way a browser tab would: the page's markup, its script
 * started by startVariablesEditor(), `fetch` stubbed. These ran the script cut out of the
 * server's template literal with `eval` in a JSDOM before it moved to src/client.
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

    (dom.window as unknown as { refresh: () => void }).refresh();
    expect(fetch).toHaveBeenCalledTimes(2);

    pending[1]!({
      ok: true,
      json: async () => ({ schema: null, live: [], combined: [{ name: 'title', value: 'newer' }] }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    pending[0]!({
      ok: true,
      json: async () => ({ schema: null, live: [], combined: [{ name: 'title', value: 'older' }] }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const valueInput = dom.window.document.querySelector<HTMLInputElement>('#content .ve-values-detail input');

    expect(valueInput?.value).toBe('newer');

    dom.close();
  });

  it('shows an error banner instead of hanging when the initial values fetch rejects', async () => {
    const dom = openEditorPage(`http://localhost${VARIABLES_EDITOR_PATH}?tab=values`);
    const fetch = vi.fn().mockRejectedValue(new Error('network down'));

    vi.stubGlobal('fetch', fetch);

    dom.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

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
    await new Promise((resolve) => setTimeout(resolve, 0));

    const button = dom.window.document.getElementById('local-update-btn') as HTMLButtonElement;

    expect(button.hidden).toBe(false);
    expect(button.textContent).toBe('Update local pages · 1');
    expect(button.title).toContain('Region: US → EMEA');
    expect(button.title).not.toContain('Limit');

    // Inline handlers don't run under runScripts: 'outside-only'; this is what the button's onclick calls.
    await (dom.window as unknown as { updateLocalValues: () => Promise<void> }).updateLocalValues();

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
    await new Promise((resolve) => setTimeout(resolve, 0));

    const button = dom.window.document.getElementById('local-update-btn') as HTMLButtonElement;
    const update = () => (dom.window as unknown as { updateLocalValues: () => Promise<void> }).updateLocalValues();

    return { dom, button, update };
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
    await new Promise((resolve) => setTimeout(resolve, 0));

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
    await new Promise((resolve) => setTimeout(resolve, 0));

    (dom.window as unknown as { showAdditionalOptionsHelp: (i: number) => void }).showAdditionalOptionsHelp(0);

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
    await new Promise((resolve) => setTimeout(resolve, 0));

    const editorWindow = dom.window as unknown as {
      save: () => void;
      updateSchemaAdditionalOptions: (index: number, value: string) => void;
    };

    editorWindow.updateSchemaAdditionalOptions(0, 'not valid JSON');
    editorWindow.save();
    await new Promise((resolve) => setTimeout(resolve, 0));

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
    await new Promise((resolve) => setTimeout(resolve, 0));

    const editorWindow = dom.window as unknown as {
      refresh: () => void;
      save: () => void;
      updateValueField: (index: number, value: string) => void;
    };
    const valueInputBeforeSave = dom.window.document.querySelector<HTMLInputElement>(
      '#content .ve-values-detail input',
    )!;

    valueInputBeforeSave.value = 'submitted';
    editorWindow.updateValueField(0, 'submitted');
    editorWindow.save();
    // save() now opens a confirmation diff modal instead of saving immediately — confirm it.
    dom.window.document.querySelector<HTMLButtonElement>('.ve-modal-ok')!.click();
    expect(fetch).toHaveBeenCalledTimes(2);

    valueInputBeforeSave.value = 'newer unsaved edit';
    editorWindow.updateValueField(0, 'newer unsaved edit');
    pending[1]!({ ok: true, json: async () => ({ ok: true, warnings: [] }) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    if (pending[2]) {
      pending[2]({
        ok: true,
        json: async () => ({ schema: null, live: [], combined: [{ name: 'title', value: 'submitted' }] }),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const valueInput = dom.window.document.querySelector<HTMLInputElement>('#content .ve-values-detail input');

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(valueInput?.value).toBe('newer unsaved edit');
    expect(dom.window.document.querySelector('#content > .banner')?.textContent).toContain(
      'Newer edits remain unsaved.',
    );

    editorWindow.refresh();
    expect(dom.window.document.querySelector('.ve-modal-title')?.textContent).toBe('Discard unsaved changes?');

    dom.close();
  });

  describe('client: failed loads and saves', () => {
    type FetchResponse = { ok: boolean; status?: number; statusText?: string; json: () => Promise<unknown> };

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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

      const editor = dom.window as unknown as {
        save: () => void;
        refresh: () => void;
        setDirty: (value: boolean) => void;
        toggleRawMode: () => void;
        toggleValuesRawMode: () => void;
        onValuesRawInput: () => void;
        updateValueField: (index: number, value: string) => void;
      };
      const banner = () => dom.window.document.querySelector('#content > .banner')?.textContent ?? '';
      const confirmSave = async () => {
        editor.save();
        dom.window.document.querySelector<HTMLButtonElement>('.ve-modal-ok')!.click();
        await flush();
      };
      const asksToDiscard = () => {
        editor.refresh();

        const asked = dom.window.document.querySelector('.ve-modal-title')?.textContent === 'Discard unsaved changes?';

        dom.window.document.querySelector<HTMLButtonElement>('.ve-modal-cancel')?.click();

        return asked;
      };

      return { dom, editor, banner, confirmSave, asksToDiscard };
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
      const { dom, editor, banner, confirmSave, asksToDiscard } = await openEditor('schema', fetch);
      const draft = '{"tags":[{"name":"title"},{"name":"subtitle"}]}';

      editor.toggleRawMode();
      dom.window.document.querySelector<HTMLTextAreaElement>('#raw-editor')!.value = draft;
      editor.setDirty(true);
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
      const { dom, editor, banner, confirmSave, asksToDiscard } = await openEditor('values', fetch);
      const draft = '[{"name":"title","value":"edited"}]';

      editor.toggleValuesRawMode();

      const rawEditor = dom.window.document.querySelector<HTMLTextAreaElement>('#values-raw-editor')!;

      rawEditor.value = draft;
      editor.onValuesRawInput();
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
      const { dom, editor, banner, confirmSave } = await openEditor('values', fetch);

      editor.updateValueField(0, 'edited');
      await confirmSave();

      expect(banner()).toContain('Save failed: Failed to save live page variables. Request failed with status 500');

      dom.close();
    });

    it('shows a network failure of a save instead of leaving it pending', async () => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(valuesResponse)
        .mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const { dom, editor, banner, confirmSave, asksToDiscard } = await openEditor('values', fetch);

      editor.updateValueField(0, 'edited');
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
      const { dom, editor, banner, confirmSave, asksToDiscard } = await openEditor('values', fetch);

      editor.updateValueField(0, 'edited');
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
      const { dom, editor, banner } = await openEditor('schema', fetch);

      expect(banner()).toContain('Failed to load the schema: Dist service or MiAPI is not defined');
      expect(dom.window.document.querySelector('#content')?.textContent).not.toContain(
        'No local __template_variables.json found',
      );

      editor.save();
      await flush();

      expect(banner()).toContain('Cannot save the schema until it has loaded successfully.');
      expect(fetch).toHaveBeenCalledTimes(1);

      dom.close();
    });
  });
});
