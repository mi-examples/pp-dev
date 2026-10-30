import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
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
    post(path: string, handler: (req: any, res: any) => any) {
      handlers.set(`POST ${path}`, handler);
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

    // The editor used to get any JSON as the schema (`{}` showed an empty table whose save dropped
    // the rest of the file), while the values routes ignored it: both now read it one way.
    it.each([['{}'], ['[]'], ['{"tags":"x"}']])('reports %s as not a schema, still returning raw text', async (raw) => {
      const distService = {
        readPublicTemplateVariablesFile: vi.fn().mockResolvedValue(Buffer.from(raw)),
      } as unknown as DistService;
      const app = register({ distService, miAPI: {} as unknown as MiAPI });
      const res = makeRes();

      await app.handlers.get('GET /@api/variables/schema')!({}, res);

      expect(res.body).toEqual({
        exists: true,
        schema: null,
        raw,
        parseError: 'The root value must be a JSON object with a "tags" array.',
      });
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

    it('answers with JSON when the file cannot be written', async () => {
      const { app, saveTemplateVariablesFile } = setup();
      const res = makeRes();

      saveTemplateVariablesFile.mockRejectedValue(new Error("EACCES: permission denied, open 'public/x'"));

      await app.handlers.get('PUT /@api/variables/schema')!({ body: { raw: '{"tags":[]}' } }, res);

      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({
        error: 'Failed to write __template_variables.json.',
        details: "EACCES: permission denied, open 'public/x'",
      });
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

    it('sends what the local pages show along, to compare with MI', async () => {
      const distService = {
        readPublicTemplateVariablesFile: vi.fn().mockResolvedValue(null),
      } as unknown as DistService;
      const miAPI = {
        getLivePageVariables: vi.fn().mockResolvedValue([{ name: 'Region', value: 'EMEA' }]),
        localPageVariables: [{ name: 'Region', value: 'US' }],
      } as unknown as MiAPI;
      const app = register({ distService, miAPI });
      const res = makeRes();

      await app.handlers.get('GET /@api/variables/values')!({}, res);

      expect(res.body.local).toEqual([{ name: 'Region', value: 'US' }]);
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

    it.each([
      [undefined],
      [null],
      ['tags'],
      [{ tags: 'x' }],
      [{ tags: [null] }],
      [{ tags: [{ name: '', value: '' }] }],
    ])('400s on the body %j', async (body) => {
      const applyPageVariables = vi.fn();
      const app = register({ miAPI: { applyPageVariables } as unknown as MiAPI });
      const res = makeRes();

      await app.handlers.get('PUT /@api/variables/values')!({ body }, res);

      expect(res.statusCode).toBe(400);
      expect(applyPageVariables).not.toHaveBeenCalled();
    });

    // Anything else an entry carried went to MI, which stores it.
    it('sends MI only the name and value of each entry', async () => {
      const distService = {
        readPublicTemplateVariablesFile: vi.fn().mockResolvedValue(null),
      } as unknown as DistService;
      const applyPageVariables = vi.fn().mockResolvedValue(undefined);
      const miAPI = { applyPageVariables, reloadPageVariables: vi.fn().mockResolvedValue([]) } as unknown as MiAPI;
      const app = register({ distService, miAPI });
      const res = makeRes();

      await app.handlers.get('PUT /@api/variables/values')!(
        { body: { tags: [{ name: 'Region', value: 'US', uid: 'x', __proto__: { injected: true }, extra: 1 }] } },
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(applyPageVariables).toHaveBeenCalledWith([{ name: 'Region', value: 'US' }]);
      expect(Object.keys(applyPageVariables.mock.calls[0][0][0])).toEqual(['name', 'value']);
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

    it('updates what the local pages show after saving', async () => {
      const distService = {
        readPublicTemplateVariablesFile: vi.fn().mockResolvedValue(null),
      } as unknown as DistService;
      const miAPI = {
        applyPageVariables: vi.fn().mockResolvedValue(undefined),
        reloadPageVariables: vi.fn().mockResolvedValue([]),
        localPageVariables: [{ name: 'x', value: 'y' }],
      } as unknown as MiAPI;
      const app = register({ distService, miAPI });
      const res = makeRes();

      await app.handlers.get('PUT /@api/variables/values')!({ body: { tags: [{ name: 'x', value: 'y' }] } }, res);

      expect(miAPI.reloadPageVariables).toHaveBeenCalledOnce();
      expect(res.body).toMatchObject({ ok: true, local: [{ name: 'x', value: 'y' }] });
      expect(res.body.localError).toBeUndefined();
    });

    it('still saves when the local pages cannot be updated, and says so', async () => {
      const distService = {
        readPublicTemplateVariablesFile: vi.fn().mockResolvedValue(null),
      } as unknown as DistService;
      const miAPI = {
        applyPageVariables: vi.fn().mockResolvedValue(undefined),
        reloadPageVariables: vi.fn().mockRejectedValue(new Error('timeout')),
      } as unknown as MiAPI;
      const app = register({ distService, miAPI });
      const res = makeRes();

      await app.handlers.get('PUT /@api/variables/values')!({ body: { tags: [{ name: 'x', value: 'y' }] } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ ok: true, localError: 'timeout' });
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

  describe('POST /@api/variables/values/local', () => {
    it('reloads the values the local pages show from MI', async () => {
      const miAPI = {
        reloadPageVariables: vi.fn().mockResolvedValue([]),
        localPageVariables: [{ name: 'Region', value: 'EMEA' }],
      } as unknown as MiAPI;
      const app = register({ miAPI });
      const res = makeRes();

      await app.handlers.get('POST /@api/variables/values/local')!({}, res);

      expect(miAPI.reloadPageVariables).toHaveBeenCalledOnce();
      expect(res.body).toEqual({ local: [{ name: 'Region', value: 'EMEA' }] });
    });

    it('502s when MI cannot be asked', async () => {
      const miAPI = { reloadPageVariables: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as MiAPI;
      const app = register({ miAPI });
      const res = makeRes();

      await app.handlers.get('POST /@api/variables/values/local')!({}, res);

      expect(res.statusCode).toBe(502);
    });
  });

  describe('GET /@api/variables/pages', () => {
    function page(
      overrides: Partial<{
        id: number;
        name: string;
        internal_name: string;
        template_id: number | null;
        template: string | null;
      }>,
    ) {
      return {
        id: 1,
        name: 'Page',
        internal_name: 'page',
        enabled: 'Y',
        visible_in_homepage: 'Y',
        template_id: null,
        template: null,
        ...overrides,
      };
    }

    it('excludes the current page and flags pages sharing its template first', async () => {
      const miAPI = {
        internalPageName: 'sales-q3',
        listPages: vi
          .fn()
          .mockResolvedValue([
            page({ id: 1, name: 'Sales Dashboard (Q3)', internal_name: 'sales-q3', template_id: 313 }),
            page({ id: 2, name: 'Sales Dashboard (Q1)', internal_name: 'sales-q1', template_id: 313 }),
            page({ id: 3, name: 'Marketing Overview', internal_name: 'marketing', template_id: 99 }),
          ]),
      } as unknown as MiAPI;
      const app = register({ miAPI });
      const res = makeRes();

      await app.handlers.get('GET /@api/variables/pages')!({}, res);

      expect(res.body.currentPageName).toBe('Sales Dashboard (Q3)');
      expect(res.body.pages).toEqual([
        { id: 2, name: 'Sales Dashboard (Q1)', internal_name: 'sales-q1', sameTemplate: true },
        { id: 3, name: 'Marketing Overview', internal_name: 'marketing', sameTemplate: false },
      ]);
    });

    it('falls back to comparing template internal_name when template_id is absent', async () => {
      const miAPI = {
        internalPageName: 'current',
        listPages: vi
          .fn()
          .mockResolvedValue([
            page({ id: 1, internal_name: 'current', template_id: null, template: 'shared-template' }),
            page({ id: 2, internal_name: 'other', template_id: null, template: 'shared-template' }),
          ]),
      } as unknown as MiAPI;
      const app = register({ miAPI });
      const res = makeRes();

      await app.handlers.get('GET /@api/variables/pages')!({}, res);

      expect(res.body.pages).toEqual([{ id: 2, name: 'Page', internal_name: 'other', sameTemplate: true }]);
    });

    it('502s when listPages throws', async () => {
      const miAPI = {
        internalPageName: 'current',
        listPages: vi.fn().mockRejectedValue(new Error('boom')),
      } as unknown as MiAPI;
      const app = register({ miAPI });
      const res = makeRes();

      await app.handlers.get('GET /@api/variables/pages')!({}, res);

      expect(res.statusCode).toBe(502);
    });
  });

  describe('GET /@api/variables/import-plan/:pageId', () => {
    it('400s on a non-numeric pageId', async () => {
      const app = register({ miAPI: {} as unknown as MiAPI });
      const res = makeRes();

      await app.handlers.get('GET /@api/variables/import-plan/:pageId')!({ params: { pageId: 'abc' } }, res);

      expect(res.statusCode).toBe(400);
    });

    it('plans an import against the current schema', async () => {
      const distService = {
        readPublicTemplateVariablesFile: vi
          .fn()
          .mockResolvedValue(Buffer.from(JSON.stringify({ tags: [{ name: 'title', tag_type: 'text' }] }))),
      } as unknown as DistService;
      const getPageVariablesFor = vi.fn().mockResolvedValue([
        { name: 'title', value: 'From other page' },
        { name: 'unknown_var', value: 'x' },
      ]);
      const app = register({ distService, miAPI: { getPageVariablesFor } as unknown as MiAPI });
      const res = makeRes();

      await app.handlers.get('GET /@api/variables/import-plan/:pageId')!({ params: { pageId: '42' } }, res);

      expect(getPageVariablesFor).toHaveBeenCalledWith(42);
      expect(res.body.importable).toEqual([{ name: 'title', sourceValue: 'From other page', tagType: 'text' }]);
      expect(res.body.skipped).toEqual([
        { name: 'unknown_var', sourceValue: 'x', reason: "Not in the current page's schema." },
      ]);
    });

    it('502s when getPageVariablesFor throws', async () => {
      const distService = {
        readPublicTemplateVariablesFile: vi.fn().mockResolvedValue(null),
      } as unknown as DistService;
      const miAPI = {
        getPageVariablesFor: vi.fn().mockRejectedValue(new Error('boom')),
      } as unknown as MiAPI;
      const app = register({ distService, miAPI });
      const res = makeRes();

      await app.handlers.get('GET /@api/variables/import-plan/:pageId')!({ params: { pageId: '1' } }, res);

      expect(res.statusCode).toBe(502);
    });
  });

  // The page was a template literal built on every request; it is now built from
  // src/client/variables-editor into dist/client, and served from there.
  describe(`GET ${VARIABLES_EDITOR_PATH}`, () => {
    let clientDir: string;

    beforeEach(() => {
      clientDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-editor-client-'));
      fs.copyFileSync(
        path.resolve(__dirname, '../../../src/client/variables-editor/variables-editor.html'),
        path.join(clientDir, 'variables-editor.html'),
      );
      fs.writeFileSync(path.join(clientDir, 'variables-editor.css'), 'body{}');
    });

    afterEach(() => {
      fs.rmSync(clientDir, { recursive: true, force: true });
    });

    const servePage = (isTemplateLess: boolean) => {
      const app = makeApp();
      const res = makeRes();

      registerVariablesEditorRoutes(app, { miAPI: { isTemplateLess } as unknown as MiAPI }, clientDir);

      return new Promise<typeof res>((resolve) => {
        res.end = (payload?: unknown) => {
          res.body = payload;
          resolve(res);
        };
        app.handlers.get(`GET ${VARIABLES_EDITOR_PATH}`)!({}, res);
      });
    };

    it('serves the built page, saying whether it has a template', async () => {
      const page = await servePage(false);

      expect(page.headers['Content-Type']).toBe('text/html; charset=utf-8');
      expect(page.body).toContain('<body data-template-less="false">');
      expect(page.body).toContain('<script type="module" src="/@pp-dev/variables-editor/variables-editor.js">');
      expect((await servePage(true)).body).toContain('<body data-template-less="true">');
    });

    it("serves the page's styles and nothing else from the folder", async () => {
      const app = makeApp();

      registerVariablesEditorRoutes(app, { miAPI: {} as unknown as MiAPI }, clientDir);

      const get = (file: string) =>
        new Promise<string | 'next'>((resolve) => {
          const res = makeRes();

          res.end = (payload?: unknown) => resolve(String(payload));
          app.handlers.get(`GET ${VARIABLES_EDITOR_PATH}/:file`)!({ params: { file } }, res, () => resolve('next'));
        });

      expect(await get('variables-editor.css')).toBe('body{}');
      expect(await get('variables-editor.html')).toBe('next');
      expect(await get('../package.json')).toBe('next');
    });

    it('no longer has the new-uid route: the page makes uids with the browser crypto', () => {
      expect(register({ miAPI: {} as unknown as MiAPI }).handlers.has('GET /@api/variables/new-uid')).toBe(false);
    });
  });
});
