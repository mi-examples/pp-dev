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

// `registerVariablesEditorRoutes` ties its handlers to the FIRST `app` it's ever called with
// for the lifetime of the process (Express routes can't be unregistered) — every subsequent
// call, even against a different `app`, only updates the module-level `current` deps ref that
// those already-registered handlers read from. So every test below shares one `app` and gets
// fresh behavior purely by re-registering with new `deps` before invoking a handler.
const sharedApp = makeApp();

function register(deps: { distService?: DistService; miAPI: MiAPI }) {
  registerVariablesEditorRoutes(sharedApp, deps);

  return sharedApp;
}

describe('registerVariablesEditorRoutes', () => {
  it('never re-registers routes on a different app instance (routesInstalled guard)', () => {
    register({ miAPI: {} as unknown as MiAPI });

    const otherApp = makeApp();

    registerVariablesEditorRoutes(otherApp, { miAPI: {} as unknown as MiAPI });

    expect(sharedApp.handlers.size).toBeGreaterThan(0);
    expect(otherApp.handlers.size).toBe(0);
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

      await app.handlers.get('PUT /@api/variables/schema')!(
        { body: { raw: JSON.stringify({ tags: 'nope' }) } },
        res,
      );

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

    it('warns (without blocking) on a name MI\'s own editor would reject, but accepts a valid one', async () => {
      const { app } = setup();
      const raw = JSON.stringify({
        tags: [
          { name: 'has a valid_name-here' },
          { name: 'has$special!chars' },
        ],
      });

      const res = makeRes();

      await app.handlers.get('PUT /@api/variables/schema')!({ body: { raw } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.warnings).toEqual([
        expect.stringContaining('"has$special!chars" contains a character'),
      ]);
    });
  });

  describe('GET /@api/variables/values', () => {
    it('combines schema defaults with live values via buildPageVariablesExport', async () => {
      const distService = {
        readPublicTemplateVariablesFile: vi.fn().mockResolvedValue(
          Buffer.from(JSON.stringify({ tags: [{ name: 'greeting', default_value: 'hello' }] })),
        ),
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
        readPublicTemplateVariablesFile: vi.fn().mockResolvedValue(
          Buffer.from(JSON.stringify({ tags: [{ name: 'flag', tag_type: 'boolean' }] })),
        ),
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

      await app.handlers.get('PUT /@api/variables/values')!(
        { body: { tags: [{ name: 'x', value: 'y' }] } },
        res,
      );

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
  });
});
