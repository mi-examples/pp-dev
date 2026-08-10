import { JSDOM } from 'jsdom';
import { describe, it, expect, vi } from 'vitest';
import { registerVariablesEditorRoutes, VARIABLES_EDITOR_PATH } from '../../../src/lib/variables-editor.js';
import type { DistService } from '../../../src/lib/dist.service.js';
import type { MiAPI } from '../../../src/lib/pp.middleware.js';

function makeApp() {
  const handlers = new Map<string, (req: any, res: any) => any>();

  const app = {
    handlers,
    get(path: string, handler: (req: any, res: any) => any) {
      handlers.set(`GET ${path}`, handler);
    },
    put(path: string, handler: (req: any, res: any) => any) {
      handlers.set(`PUT ${path}`, handler);
    },
  };

  return app as unknown as import('express').Application & { handlers: typeof handlers };
}

function makeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;

      return res;
    },
    json(payload: unknown) {
      res.body = payload;

      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    end(payload?: unknown) {
      res.body = payload;
    },
  };

  return res;
}

function register(deps: { distService?: DistService; miAPI: MiAPI }) {
  const app = makeApp();

  registerVariablesEditorRoutes(app, deps);

  return app;
}

describe('registerVariablesEditorRoutes', () => {
  it('registers routes on every app instance', () => {
    const firstApp = register({ miAPI: {} as unknown as MiAPI });
    const secondApp = register({ miAPI: {} as unknown as MiAPI });

    expect(firstApp.handlers.size).toBeGreaterThan(0);
    expect(secondApp.handlers.size).toBe(firstApp.handlers.size);
  });

  it('keeps dependencies isolated between app instances', async () => {
    const firstApp = register({
      distService: {
        readPublicTemplateVariablesFile: vi.fn().mockResolvedValue(Buffer.from('{"tags":[{"name":"first"}]}')),
      } as unknown as DistService,
      miAPI: {} as unknown as MiAPI,
    });
    const secondApp = register({
      distService: {
        readPublicTemplateVariablesFile: vi.fn().mockResolvedValue(Buffer.from('{"tags":[{"name":"second"}]}')),
      } as unknown as DistService,
      miAPI: {} as unknown as MiAPI,
    });
    const firstRes = makeRes();
    const secondRes = makeRes();

    await firstApp.handlers.get('GET /@api/variables/schema')!({}, firstRes);
    await secondApp.handlers.get('GET /@api/variables/schema')!({}, secondRes);

    expect(firstRes.body.schema.tags[0].name).toBe('first');
    expect(secondRes.body.schema.tags[0].name).toBe('second');
  });

  it('updates dependencies when the same app is registered again', async () => {
    const app = makeApp();
    const firstDistService = {
      readPublicTemplateVariablesFile: vi.fn().mockResolvedValue(Buffer.from('{"tags":[{"name":"first"}]}')),
    } as unknown as DistService;
    const secondDistService = {
      readPublicTemplateVariablesFile: vi.fn().mockResolvedValue(Buffer.from('{"tags":[{"name":"second"}]}')),
    } as unknown as DistService;
    const res = makeRes();

    registerVariablesEditorRoutes(app, { distService: firstDistService, miAPI: {} as unknown as MiAPI });
    registerVariablesEditorRoutes(app, { distService: secondDistService, miAPI: {} as unknown as MiAPI });
    await app.handlers.get('GET /@api/variables/schema')!({}, res);

    expect(res.body.schema.tags[0].name).toBe('second');
  });

  describe('GET /@api/variables/schema', () => {
    it('errors when distService is not defined', async () => {
      const app = register({ miAPI: {} as unknown as MiAPI });
      const res = makeRes();

      await app.handlers.get('GET /@api/variables/schema')!({}, res);

      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({ error: 'Dist service or MiAPI is not defined' });
    });

    it('reports exists:false when the file is missing', async () => {
      const distService = {
        readPublicTemplateVariablesFile: vi.fn().mockResolvedValue(null),
      } as unknown as DistService;
      const app = register({ distService, miAPI: {} as unknown as MiAPI });
      const res = makeRes();

      await app.handlers.get('GET /@api/variables/schema')!({}, res);

      expect(res.body).toEqual({ exists: false, schema: null, raw: null });
    });

    it('returns the parsed schema plus raw text for a valid file', async () => {
      const raw = JSON.stringify({ tags: [{ name: 'foo' }] });
      const distService = {
        readPublicTemplateVariablesFile: vi.fn().mockResolvedValue(Buffer.from(raw)),
      } as unknown as DistService;
      const app = register({ distService, miAPI: {} as unknown as MiAPI });
      const res = makeRes();

      await app.handlers.get('GET /@api/variables/schema')!({}, res);

      expect(res.body).toEqual({ exists: true, schema: { tags: [{ name: 'foo' }] }, raw });
    });

    it('reports a parseError for a corrupt file, still returning raw text', async () => {
      const distService = {
        readPublicTemplateVariablesFile: vi.fn().mockResolvedValue(Buffer.from('not json')),
      } as unknown as DistService;
      const app = register({ distService, miAPI: {} as unknown as MiAPI });
      const res = makeRes();

      await app.handlers.get('GET /@api/variables/schema')!({}, res);

      expect(res.body.exists).toBe(true);
      expect(res.body.schema).toBeNull();
      expect(res.body.raw).toBe('not json');
      expect(res.body.parseError).toBeTruthy();
    });
  });

  describe('PUT /@api/variables/schema', () => {
    function setup() {
      const saveTemplateVariablesFile = vi.fn().mockResolvedValue('public/__template_variables.json');
      const distService = {
        readPublicTemplateVariablesFile: vi.fn(),
        saveTemplateVariablesFile,
      } as unknown as DistService;
      const app = register({ distService, miAPI: {} as unknown as MiAPI });

      return { app, saveTemplateVariablesFile };
    }

    it('400s on malformed JSON', async () => {
      const { app } = setup();
      const res = makeRes();

      await app.handlers.get('PUT /@api/variables/schema')!({ body: { raw: 'not json' } }, res);

      expect(res.statusCode).toBe(400);
    });

    it('400s when tags is not an array', async () => {
      const { app } = setup();
      const res = makeRes();

      await app.handlers.get('PUT /@api/variables/schema')!({ body: { raw: JSON.stringify({ tags: 'nope' }) } }, res);

      expect(res.statusCode).toBe(400);
    });

    it('400s when a tag is missing a non-empty name', async () => {
      const { app } = setup();
      const res = makeRes();

      await app.handlers.get('PUT /@api/variables/schema')!(
        { body: { raw: JSON.stringify({ tags: [{ name: '' }] }) } },
        res,
      );

      expect(res.statusCode).toBe(400);
    });

    it('saves and returns warnings for duplicate names / unknown tag_type, without blocking', async () => {
      const { app, saveTemplateVariablesFile } = setup();
      const raw = JSON.stringify({
        tags: [
          { name: 'dup', tag_type: 'text' },
          { name: 'dup', tag_type: 'not-a-real-type' },
        ],
      });

      const res = makeRes();

      await app.handlers.get('PUT /@api/variables/schema')!({ body: { raw } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.warnings.length).toBeGreaterThanOrEqual(2);
      expect(saveTemplateVariablesFile).toHaveBeenCalledWith(Buffer.from(raw, 'utf-8'));
    });

    it("warns (without blocking) on a name MI's own editor would reject, but accepts a valid one", async () => {
      const { app } = setup();
      const raw = JSON.stringify({
        tags: [{ name: 'has a valid_name-here' }, { name: 'has$special!chars' }],
      });

      const res = makeRes();

      await app.handlers.get('PUT /@api/variables/schema')!({ body: { raw } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.warnings).toEqual([expect.stringContaining('"has$special!chars" contains a character')]);
    });
  });

  describe('GET /@api/variables/values', () => {
    it('combines schema defaults with live values via buildPageVariablesExport', async () => {
      const distService = {
        readPublicTemplateVariablesFile: vi
          .fn()
          .mockResolvedValue(Buffer.from(JSON.stringify({ tags: [{ name: 'greeting', default_value: 'hello' }] }))),
      } as unknown as DistService;
      const miAPI = {
        getLivePageVariables: vi.fn().mockResolvedValue([{ name: 'title', value: 'Live Title' }]),
      } as unknown as MiAPI;
      const app = register({ distService, miAPI });
      const res = makeRes();

      await app.handlers.get('GET /@api/variables/values')!({}, res);

      expect(res.body.live).toEqual([{ name: 'title', value: 'Live Title' }]);
      expect(res.body.combined).toEqual(
        expect.arrayContaining([
          { name: 'greeting', value: 'hello' },
          { name: 'title', value: 'Live Title' },
        ]),
      );
    });

    it('502s when fetching live variables fails', async () => {
      const distService = {
        readPublicTemplateVariablesFile: vi.fn().mockResolvedValue(null),
      } as unknown as DistService;
      const miAPI = {
        getLivePageVariables: vi.fn().mockRejectedValue(new Error('boom')),
      } as unknown as MiAPI;
      const app = register({ distService, miAPI });
      const res = makeRes();

      await app.handlers.get('GET /@api/variables/values')!({}, res);

      expect(res.statusCode).toBe(502);
    });
  });

  describe('PUT /@api/variables/values', () => {
    it('400s on a malformed body', async () => {
      const app = register({ miAPI: { applyPageVariables: vi.fn() } as unknown as MiAPI });
      const res = makeRes();

      await app.handlers.get('PUT /@api/variables/values')!({ body: { tags: [{ name: 'x' }] } }, res);

      expect(res.statusCode).toBe(400);
    });

    it('saves and returns non-blocking warnings from validateValueAgainstTag', async () => {
      const distService = {
        readPublicTemplateVariablesFile: vi
          .fn()
          .mockResolvedValue(Buffer.from(JSON.stringify({ tags: [{ name: 'flag', tag_type: 'boolean' }] }))),
      } as unknown as DistService;
      const applyPageVariables = vi.fn().mockResolvedValue(undefined);
      const app = register({ distService, miAPI: { applyPageVariables } as unknown as MiAPI });
      const res = makeRes();

      await app.handlers.get('PUT /@api/variables/values')!(
        { body: { tags: [{ name: 'flag', value: 'not-a-bool' }] } },
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.warnings).toContainEqual(expect.objectContaining({ name: 'flag', severity: 'warning' }));
      expect(applyPageVariables).toHaveBeenCalledWith([{ name: 'flag', value: 'not-a-bool' }]);
    });

    it('502s when applyPageVariables throws', async () => {
      const distService = {
        readPublicTemplateVariablesFile: vi.fn().mockResolvedValue(null),
      } as unknown as DistService;
      const miAPI = {
        applyPageVariables: vi.fn().mockRejectedValue(new Error('boom')),
      } as unknown as MiAPI;
      const app = register({ distService, miAPI });
      const res = makeRes();

      await app.handlers.get('PUT /@api/variables/values')!({ body: { tags: [{ name: 'x', value: 'y' }] } }, res);

      expect(res.statusCode).toBe(502);
    });
  });

  describe('GET /@api/variables/new-uid', () => {
    it('returns a 32-char lowercase hex md5-shaped uid', async () => {
      const app = register({ miAPI: {} as unknown as MiAPI });
      const res = makeRes();

      await app.handlers.get('GET /@api/variables/new-uid')!({}, res);

      expect(res.body.uid).toMatch(/^[0-9a-f]{32}$/);
    });

    it('returns a fresh uid on every call', async () => {
      const app = register({ miAPI: {} as unknown as MiAPI });
      const res1 = makeRes();
      const res2 = makeRes();

      await app.handlers.get('GET /@api/variables/new-uid')!({}, res1);
      await app.handlers.get('GET /@api/variables/new-uid')!({}, res2);

      expect(res1.body.uid).not.toBe(res2.body.uid);
    });
  });

  describe(`GET ${VARIABLES_EDITOR_PATH}`, () => {
    it('serves an HTML page', async () => {
      const app = register({ miAPI: {} as unknown as MiAPI });
      const res = makeRes();

      app.handlers.get(`GET ${VARIABLES_EDITOR_PATH}`)!({}, res);

      expect(res.headers['Content-Type']).toContain('text/html');
      expect(typeof res.body).toBe('string');
      expect(res.body).toContain('Variables Editor');
    });

    it('shows an info message with no tabs/Save when the page is templateLess', async () => {
      const app = register({ miAPI: { isTemplateLess: true } as unknown as MiAPI });
      const res = makeRes();

      app.handlers.get(`GET ${VARIABLES_EDITOR_PATH}`)!({}, res);

      expect(res.body).toContain('no associated template');
      expect(res.body).not.toContain('id="tab-schema"');
      expect(res.body).not.toContain('id="save-btn"');
    });

    // Every `<script>` block is built via string concatenation inside one giant template
    // literal — a backslash-escaping mistake there (e.g. a regex like /\\/) is invisible to
    // `tsc`/eslint (it's just characters inside a string) and only breaks at runtime when the
    // browser parses it, which none of the tests above would ever catch. `new Function` parses
    // without executing, so this fails fast on any embedded-script SyntaxError.
    it('embeds syntactically valid client-side JavaScript in every <script> block', async () => {
      const app = register({ miAPI: { isTemplateLess: false } as unknown as MiAPI });
      const res = makeRes();

      app.handlers.get(`GET ${VARIABLES_EDITOR_PATH}`)!({}, res);

      const html = res.body as string;
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

      expect(scripts.length).toBeGreaterThan(0);

      for (const script of scripts) {
        expect(() => new Function(script)).not.toThrow();
      }
    });

    // Same template-literal backslash pitfall as above, but silent rather than a SyntaxError:
    // a bare \s in the source collapses to a literal "s", so the embedded regex still parses
    // fine but silently stops matching whitespace — the "Contains a character..." hint would
    // then fire on every name containing a space. Extract the actual embedded regex text so a
    // future regression here fails a test instead of only showing up as a UI bug report.
    it('embeds a client-side NAME_FORMAT_REGEX that still allows whitespace in names', async () => {
      const app = register({ miAPI: { isTemplateLess: false } as unknown as MiAPI });
      const res = makeRes();

      app.handlers.get(`GET ${VARIABLES_EDITOR_PATH}`)!({}, res);

      const html = res.body as string;
      const match = html.match(/const NAME_FORMAT_REGEX = (\/.*\/);/);

      expect(match).not.toBeNull();

      const re = new Function(`return ${match![1]};`)();

      expect(re.test('Connection Report Meta')).toBe(true);
      expect(re.test('bad$name')).toBe(false);
    });

    it('keeps the newest values response when overlapping loads resolve out of order', async () => {
      const app = register({ miAPI: { isTemplateLess: false } as unknown as MiAPI });
      const res = makeRes();

      app.handlers.get(`GET ${VARIABLES_EDITOR_PATH}`)!({}, res);

      const dom = new JSDOM(res.body as string, {
        runScripts: 'outside-only',
        url: `http://localhost${VARIABLES_EDITOR_PATH}?tab=values`,
      });
      const pending: Array<(response: { ok: boolean; json: () => Promise<unknown> }) => void> = [];
      const fetch = vi.fn(
        () =>
          new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
            pending.push(resolve);
          }),
      );

      Object.defineProperty(dom.window, 'fetch', { configurable: true, value: fetch });

      const scripts = [...(res.body as string).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

      dom.window.eval(scripts.at(-1)!);
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

      const valueInput = dom.window.document.querySelector<HTMLInputElement>('#content tbody input');

      expect(valueInput?.value).toBe('newer');

      dom.window.close();
    });

    it('does not save malformed additional_options text as a string', async () => {
      const app = register({ miAPI: { isTemplateLess: false } as unknown as MiAPI });
      const res = makeRes();

      app.handlers.get(`GET ${VARIABLES_EDITOR_PATH}`)!({}, res);

      const dom = new JSDOM(res.body as string, {
        runScripts: 'outside-only',
        url: `http://localhost${VARIABLES_EDITOR_PATH}?tab=schema`,
      });
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

      Object.defineProperty(dom.window, 'fetch', { configurable: true, value: fetch });

      const scripts = [...(res.body as string).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

      dom.window.eval(scripts.at(-1)!);
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

      dom.window.close();
    });

    it('preserves value edits made while a save request is pending', async () => {
      const app = register({ miAPI: { isTemplateLess: false } as unknown as MiAPI });
      const res = makeRes();

      app.handlers.get(`GET ${VARIABLES_EDITOR_PATH}`)!({}, res);

      const dom = new JSDOM(res.body as string, {
        runScripts: 'outside-only',
        url: `http://localhost${VARIABLES_EDITOR_PATH}?tab=values`,
      });
      const pending: Array<(response: { ok: boolean; json: () => Promise<unknown> }) => void> = [];
      const fetch = vi.fn(
        () =>
          new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
            pending.push(resolve);
          }),
      );

      Object.defineProperty(dom.window, 'fetch', { configurable: true, value: fetch });

      const scripts = [...(res.body as string).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

      dom.window.eval(scripts.at(-1)!);
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
      const valueInputBeforeSave = dom.window.document.querySelector<HTMLInputElement>('#content tbody input')!;

      valueInputBeforeSave.value = 'submitted';
      editorWindow.updateValueField(0, 'submitted');
      editorWindow.save();
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

      const valueInput = dom.window.document.querySelector<HTMLInputElement>('#content tbody input');

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(valueInput?.value).toBe('newer unsaved edit');
      expect(dom.window.document.querySelector('#content > .banner')?.textContent).toContain(
        'Newer edits remain unsaved.',
      );

      editorWindow.refresh();
      expect(dom.window.document.querySelector('.ve-modal-title')?.textContent).toBe('Discard unsaved changes?');

      dom.window.close();
    });
  });
});
