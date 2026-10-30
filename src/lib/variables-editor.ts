import type { Application } from 'express';
import { DistService, TEMPLATE_VARIABLES_FILE_NAME } from './dist.service.js';
import { MiAPI } from './pp.middleware.js';
import { serveClientPage } from './client-page.js';
import {
  buildPageVariablesExport,
  isTemplateVariableTagType,
  planPageVariablesImport,
  validateValueAgainstTag,
  PageVariableEntry,
  PageVariableValidationIssue,
  TemplateVariableTag,
  TemplateVariablesSchema,
} from './page-variables-diff.js';

export const VARIABLES_EDITOR_PATH = '/@pp-dev/variables-editor';

// Matches MI's own "Create/Edit Variable" form: letters, digits, underscore, whitespace, hyphen.
const NAME_FORMAT_REGEX = /^[A-Za-z0-9_\s-]+$/;
const MISSING_DEPS_ERROR = 'Dist service or MiAPI is not defined';

interface VariablesEditorRouteState {
  deps: { distService?: DistService; miAPI: MiAPI };
}

const routeStates = new WeakMap<Application, VariablesEditorRouteState>();

/** The schema file: its text, and the schema when it is a JSON object with a `tags` array. */
interface SchemaFile {
  raw: string;
  schema: TemplateVariablesSchema | null;
  /** Why {@link schema} is `null`. */
  parseError?: string;
}

/**
 * Reads the schema file, `null` when there is none. The one reading of it, so the editor and the
 * routes that check values against it agree on what counts as a schema.
 */
async function readSchemaFile(distService: DistService): Promise<SchemaFile | null> {
  const buffer = await distService.readPublicTemplateVariablesFile();

  if (!buffer) {
    return null;
  }

  const raw = buffer.toString('utf-8');
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { raw, schema: null, parseError: error instanceof Error ? error.message : 'Invalid JSON' };
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as { tags?: unknown }).tags)
  ) {
    return { raw, schema: null, parseError: 'The root value must be a JSON object with a "tags" array.' };
  }

  return { raw, schema: parsed as TemplateVariablesSchema };
}

/** `null` when the file is missing, unreadable, or not valid `{tags: [...]}`. */
async function readSchema(distService: DistService | undefined): Promise<TemplateVariablesSchema | null> {
  return distService ? ((await readSchemaFile(distService))?.schema ?? null) : null;
}

/**
 * The `{name, value}[]` a request body's `tags` must be, copied to just those two keys (MI stores
 * whatever else an entry carries); `null` when it isn't one.
 */
function readPageVariableEntries(body: unknown): PageVariableEntry[] | null {
  const tags = typeof body === 'object' && body !== null ? (body as { tags?: unknown }).tags : undefined;

  if (!Array.isArray(tags)) {
    return null;
  }

  const entries: PageVariableEntry[] = [];

  for (const entry of tags as unknown[]) {
    if (typeof entry !== 'object' || entry === null) {
      return null;
    }

    const { name, value } = entry as { name?: unknown; value?: unknown };

    if (typeof name !== 'string' || !name || typeof value !== 'string') {
      return null;
    }

    entries.push({ name, value });
  }

  return entries;
}

export function registerVariablesEditorRoutes(
  app: Application,
  deps: { distService?: DistService; miAPI: MiAPI },
  clientDir?: string,
): void {
  const existing = routeStates.get(app);

  if (existing) {
    existing.deps = deps;

    return;
  }

  const current: VariablesEditorRouteState = { deps };

  routeStates.set(app, current);

  // ── API: read the schema file ───────────────────────────────────────────────
  app.get('/@api/variables/schema', async (_req, res) => {
    const { distService } = current.deps;

    if (!distService) {
      res.status(503).json({ error: MISSING_DEPS_ERROR });

      return;
    }

    const file = await readSchemaFile(distService);

    res.json(file ? { exists: true, ...file } : { exists: false, schema: null, raw: null });
  });

  // ── API: write the schema file ──────────────────────────────────────────────
  app.put('/@api/variables/schema', async (req, res) => {
    const { distService } = current.deps;

    if (!distService) {
      res.status(503).json({ error: MISSING_DEPS_ERROR });

      return;
    }

    const raw: unknown = (req.body as { raw?: unknown } | undefined)?.raw;

    if (typeof raw !== 'string') {
      res.status(400).json({ error: 'Request body must be { raw: string }.' });

      return;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      res.status(400).json({ error: 'Not valid JSON.' });

      return;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      res.status(400).json({ error: 'The root value must be a JSON object.' });

      return;
    }

    const tags = (parsed as { tags?: unknown }).tags;

    if (!Array.isArray(tags)) {
      res.status(400).json({ error: '"tags" must be an array.' });

      return;
    }

    const invalidIndex = tags.findIndex(
      (tag) =>
        typeof tag !== 'object' ||
        tag === null ||
        typeof (tag as { name?: unknown }).name !== 'string' ||
        !(tag as { name: string }).name,
    );

    if (invalidIndex !== -1) {
      res.status(400).json({ error: `tags[${invalidIndex}] is missing a non-empty "name".` });

      return;
    }

    const warnings: string[] = [];
    const seenNames = new Set<string>();

    for (const tag of tags as TemplateVariableTag[]) {
      if (seenNames.has(tag.name)) {
        warnings.push(`Duplicate variable name "${tag.name}".`);
      }

      seenNames.add(tag.name);

      if (tag.tag_type && !isTemplateVariableTagType(tag.tag_type)) {
        warnings.push(`"${tag.name}" has an unrecognized tag_type "${tag.tag_type}".`);
      }

      // MI's own "Create/Edit Variable" form blocks names outside this pattern; here it's a
      // warning, not a hard block, since this endpoint also has to accept legacy/imported data.
      if (!NAME_FORMAT_REGEX.test(tag.name)) {
        warnings.push(
          `"${tag.name}" contains a character MI's own editor doesn't allow (only letters, digits, underscore, hyphen, and whitespace).`,
        );
      }
    }

    try {
      await distService.saveTemplateVariablesFile(Buffer.from(raw, 'utf-8'));
    } catch (error) {
      // EACCES, ENOSPC, a read-only checkout: say so as JSON, which the editor shows, rather than
      // letting Express answer with an HTML error page.
      res.status(500).json({
        error: `Failed to write ${TEMPLATE_VARIABLES_FILE_NAME}.`,
        details: error instanceof Error ? error.message : String(error),
      });

      return;
    }

    res.json({ ok: true, warnings });
  });

  // ── API: read live values (+ schema, + the combined "what to show" view) ───
  app.get('/@api/variables/values', async (_req, res) => {
    const { distService, miAPI } = current.deps;

    try {
      const schema = await readSchema(distService);
      const live = await miAPI.getLivePageVariables();
      const combined = buildPageVariablesExport(schema, live);

      // What the local pages show, so the editor can offer to bring them up to date with MI.
      res.json({ schema, live, combined, local: miAPI.localPageVariables ?? null });
    } catch (error) {
      res.status(502).json({
        error: 'Failed to fetch live page variables.',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ── API: write live values (full replacement, matches MI's own PUT) ────────
  app.put('/@api/variables/values', async (req, res) => {
    const { distService, miAPI } = current.deps;
    const tags = readPageVariableEntries(req.body);

    if (!tags) {
      res.status(400).json({ error: 'Request body must be { tags: {name, value}[] }.' });

      return;
    }

    try {
      const schema = await readSchema(distService);
      const schemaMap = new Map<string, TemplateVariableTag>((schema?.tags ?? []).map((tag) => [tag.name, tag]));
      const warnings: PageVariableValidationIssue[] = [];

      for (const entry of tags) {
        const tag = schemaMap.get(entry.name);

        if (tag) {
          warnings.push(...validateValueAgainstTag(tag, entry.value));
        }
      }

      await miAPI.applyPageVariables(tags);

      // The local pages show the saved values from their next load on. If MI can't be asked now,
      // the save still stands, and the editor offers to update them later.
      let localError: string | undefined;

      try {
        await miAPI.reloadPageVariables();
      } catch (error) {
        localError = error instanceof Error ? error.message : String(error);
      }

      res.json({ ok: true, warnings, local: miAPI.localPageVariables ?? null, ...(localError ? { localError } : {}) });
    } catch (error) {
      res.status(502).json({
        error: 'Failed to save live page variables.',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ── API: bring the values the local pages show up to date with MI (changed in MI itself, or a
  // save whose update failed). Every user's tab shows them from its next load on. ──────────────
  app.post('/@api/variables/values/local', async (_req, res) => {
    const { miAPI } = current.deps;

    try {
      await miAPI.reloadPageVariables();

      res.json({ local: miAPI.localPageVariables ?? null });
    } catch (error) {
      res.status(502).json({
        error: 'Failed to update the local values.',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ── API: generate a uid for a new schema row (Node's crypto has real MD5; browsers don't) ──
  // ── API: candidate pages to import values from — every other page, pages sharing the
  // current template flagged so the UI can list them first ──────────────────────────────
  app.get('/@api/variables/pages', async (_req, res) => {
    const { miAPI } = current.deps;

    try {
      const allPages = await miAPI.listPages();
      const currentPage = allPages.find((page) => page.internal_name === miAPI.internalPageName) ?? null;

      const pages = allPages
        .filter((page) => page.internal_name !== miAPI.internalPageName)
        .map((page) => ({
          id: page.id,
          name: page.name,
          internal_name: page.internal_name,
          sameTemplate:
            !!currentPage &&
            (currentPage.template_id != null
              ? page.template_id === currentPage.template_id
              : !!currentPage.template && page.template === currentPage.template),
        }));

      res.json({ pages, currentPageName: currentPage?.name ?? null });
    } catch (error) {
      res.status(502).json({
        error: 'Failed to fetch the page list.',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ── API: plan an import of another page's live values into the current page's schema —
  // matched by name, then checked against the target variable's type ─────────────────────
  app.get('/@api/variables/import-plan/:pageId', async (req, res) => {
    const { distService, miAPI } = current.deps;
    const pageId = Number(req.params.pageId);

    if (!Number.isInteger(pageId) || pageId <= 0) {
      res.status(400).json({ error: 'pageId must be a positive integer.' });

      return;
    }

    try {
      const schema = await readSchema(distService);
      const sourceValues = await miAPI.getPageVariablesFor(pageId);

      res.json(planPageVariablesImport(schema, sourceValues));
    } catch (error) {
      res.status(502).json({
        error: 'Failed to fetch values from the selected page.',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ── Web UI ───────────────────────────────────────────────────────────────────
  // The page, built from src/client/variables-editor into dist/client, and its script and styles.
  serveClientPage(app, {
    path: VARIABLES_EDITOR_PATH,
    name: 'variables-editor',
    clientDir,
    values: () => ({ templateLess: String(Boolean(current.deps.miAPI.isTemplateLess)) }),
  });
}
