import type { Application } from 'express';
import { createHash, randomUUID } from 'crypto';
import { DistService } from './dist.service.js';
import { MiAPI } from './pp.middleware.js';
import {
  buildPageVariablesExport,
  planPageVariablesImport,
  validateValueAgainstTag,
  PageVariableEntry,
  PageVariableValidationIssue,
  TemplateVariableTag,
  TemplateVariablesSchema,
} from './page-variables-diff.js';

export const VARIABLES_EDITOR_PATH = '/@pp-dev/variables-editor';

const KNOWN_TAG_TYPES = new Set(['text', 'select', 'multiselect', 'file', 'list', 'color', 'boolean']);
// Matches MI's own "Create/Edit Variable" form: letters, digits, underscore, whitespace, hyphen.
const NAME_FORMAT_REGEX = /^[A-Za-z0-9_\s-]+$/;
const MISSING_DEPS_ERROR = 'Dist service or MiAPI is not defined';

interface VariablesEditorRouteState {
  deps: { distService?: DistService; miAPI: MiAPI };
}

const routeStates = new WeakMap<Application, VariablesEditorRouteState>();

/** `null` when the file is missing, unreadable, or not valid `{tags: [...]}`. */
async function readSchema(distService: DistService | undefined): Promise<TemplateVariablesSchema | null> {
  if (!distService) {
    return null;
  }

  const buffer = await distService.readPublicTemplateVariablesFile();

  if (!buffer) {
    return null;
  }

  try {
    const parsed = JSON.parse(buffer.toString('utf-8'));

    return parsed && Array.isArray(parsed.tags) ? (parsed as TemplateVariablesSchema) : null;
  } catch {
    return null;
  }
}

export function registerVariablesEditorRoutes(
  app: Application,
  deps: { distService?: DistService; miAPI: MiAPI },
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

    const buffer = await distService.readPublicTemplateVariablesFile();

    if (!buffer) {
      res.json({ exists: false, schema: null, raw: null });

      return;
    }

    const raw = buffer.toString('utf-8');

    try {
      res.json({ exists: true, schema: JSON.parse(raw), raw });
    } catch (error) {
      res.json({
        exists: true,
        schema: null,
        raw,
        parseError: error instanceof Error ? error.message : 'Invalid JSON',
      });
    }
  });

  // ── API: write the schema file ──────────────────────────────────────────────
  app.put('/@api/variables/schema', async (req, res) => {
    const { distService } = current.deps;

    if (!distService) {
      res.status(503).json({ error: MISSING_DEPS_ERROR });

      return;
    }

    const raw = req.body?.raw;

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

      if (tag.tag_type && !KNOWN_TAG_TYPES.has(tag.tag_type)) {
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

    await distService.saveTemplateVariablesFile(Buffer.from(raw, 'utf-8'));

    res.json({ ok: true, warnings });
  });

  // ── API: read live values (+ schema, + the combined "what to show" view) ───
  app.get('/@api/variables/values', async (_req, res) => {
    const { distService, miAPI } = current.deps;

    try {
      const schema = await readSchema(distService);
      const live = await miAPI.getLivePageVariables();
      const combined = buildPageVariablesExport(schema, live);

      res.json({ schema, live, combined });
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
    const tags = req.body?.tags;

    if (
      !Array.isArray(tags) ||
      tags.some(
        (entry) =>
          typeof entry !== 'object' ||
          entry === null ||
          typeof entry.name !== 'string' ||
          !entry.name ||
          typeof entry.value !== 'string',
      )
    ) {
      res.status(400).json({ error: 'Request body must be { tags: {name, value}[] }.' });

      return;
    }

    try {
      const schema = await readSchema(distService);
      const schemaMap = new Map<string, TemplateVariableTag>((schema?.tags ?? []).map((tag) => [tag.name, tag]));
      const warnings: PageVariableValidationIssue[] = [];

      for (const entry of tags as PageVariableEntry[]) {
        const tag = schemaMap.get(entry.name);

        if (tag) {
          warnings.push(...validateValueAgainstTag(tag, entry.value));
        }
      }

      await miAPI.applyPageVariables(tags as PageVariableEntry[]);

      res.json({ ok: true, warnings });
    } catch (error) {
      res.status(502).json({
        error: 'Failed to save live page variables.',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ── API: generate a uid for a new schema row (Node's crypto has real MD5; browsers don't) ──
  app.get('/@api/variables/new-uid', (_req, res) => {
    res.json({ uid: createHash('md5').update(randomUUID()).digest('hex') });
  });

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
          sameTemplate: !!currentPage && (
            currentPage.template_id != null
              ? page.template_id === currentPage.template_id
              : !!currentPage.template && page.template === currentPage.template
          ),
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
  app.get(VARIABLES_EDITOR_PATH, (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(getVariablesEditorHtml(current.deps.miAPI.isTemplateLess));
  });
}

function getVariablesEditorHtml(templateLess: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Variables Editor — pp-dev</title>
<script>
// Set the stored theme override before first paint, so switching pages/reloading doesn't
// flash the OS-default theme before settling on the user's explicit choice (see setTheme()).
try {
  var ppDevStoredTheme = localStorage.getItem('pp-dev-info-theme');

  if (ppDevStoredTheme === 'dark' || ppDevStoredTheme === 'light') {
    document.documentElement.setAttribute('data-pp-dev-theme', ppDevStoredTheme);
  }
} catch (e) {}
</script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root,:root[data-pp-dev-theme="light"]{
  --bg:#ffffff;--bg2:#f4f5f7;--bg3:#e9ebef;--bg4:#dbdee3;
  --border:#d7dae0;--border2:#c2c6cd;
  --text:#1a1a1e;--text2:#54566b;--text3:#8a8c9c;
  --accent:#4f46e5;--accent2:#7c3aed;
  --m-accent:var(--accent);--m-bg2:var(--bg2);
  --green:#16a34a;--red:#dc2626;--yellow:#a16207;--blue:#2563eb;
  --btn-primary-fg:#ffffff;
  --font-mono:'Cascadia Code','Fira Code','JetBrains Mono',Consolas,monospace;
  --font-ui:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
}
:root[data-pp-dev-theme="dark"]{
  --bg:#1a1a1e;--bg2:#222228;--bg3:#2a2a32;--bg4:#32323c;
  --border:#3a3a46;--border2:#4a4a58;
  --text:#e0e0f0;--text2:#a0a0b8;--text3:#606078;
  --accent:#6e8efb;--accent2:#a78bfa;
  --m-accent:var(--accent);--m-bg2:var(--bg2);
  --green:#4ade80;--red:#f87171;--yellow:#fbbf24;--blue:#60a5fa;
  --btn-primary-fg:#0d0d10;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#1a1a1e;--bg2:#222228;--bg3:#2a2a32;--bg4:#32323c;
    --border:#3a3a46;--border2:#4a4a58;
    --text:#e0e0f0;--text2:#a0a0b8;--text3:#606078;
    --accent:#6e8efb;--accent2:#a78bfa;
    --m-accent:var(--accent);--m-bg2:var(--bg2);
    --green:#4ade80;--red:#f87171;--yellow:#fbbf24;--blue:#60a5fa;
    --btn-primary-fg:#0d0d10;
  }
}
html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--text);font-family:var(--font-ui);font-size:13px;line-height:1.5}
.app{display:flex;flex-direction:column;height:100vh}
.toolbar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg2);border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap}
.toolbar-title{font-weight:600;font-size:14px;margin-right:8px}
.tabs{display:flex;gap:4px}
.tab{padding:5px 12px;border-radius:4px;border:1px solid transparent;background:transparent;color:var(--text2);font-size:12px;cursor:pointer}
.tab:hover{background:var(--bg3);color:var(--text)}
.tab.active{background:var(--bg4);color:var(--text);border-color:var(--border2)}
.toolbar-spacer{flex:1}
.ve-loading-indicator{display:inline-flex;align-items:center;gap:6px;color:var(--text3);font-size:11px}
.ve-loading-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);animation:ve-pulse 1s ease-in-out infinite}
.ve-skeleton{padding:16px}
.ve-skeleton-row{height:32px;border-radius:4px;background:var(--bg3);margin-bottom:8px;animation:ve-pulse 1.4s ease-in-out infinite}
.ve-skeleton-row:nth-child(2){width:92%}
.ve-skeleton-row:nth-child(3){width:96%}
.ve-skeleton-row:nth-child(4){width:88%}
.ve-skeleton-row:nth-child(5){width:94%}
@keyframes ve-pulse{0%,100%{opacity:1}50%{opacity:.4}}
.theme-switch{display:flex;gap:2px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;padding:2px}
.theme-switch button{padding:3px 8px;border:none;border-radius:3px;background:transparent;color:var(--text2);font-size:11px;cursor:pointer;font-family:var(--font-ui)}
.theme-switch button.active{background:var(--accent);color:var(--btn-primary-fg)}
.btn{padding:5px 12px;border-radius:4px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:12px;cursor:pointer;transition:background .1s}
.btn:hover{background:var(--bg4);border-color:var(--border2)}
.btn-primary{background:var(--accent);border-color:var(--accent);color:var(--btn-primary-fg);font-weight:600}
.btn-primary:hover{opacity:.9;background:var(--accent)}
.btn-sm{padding:5px 8px;font-size:11px;min-width:30px;min-height:30px;}
.content{flex:1;overflow:auto;padding:14px}
.banner{margin-bottom:12px;padding:8px 12px;border-radius:4px;font-size:12px}
.banner-warning{background:color-mix(in srgb, var(--yellow) 15%, var(--bg));color:var(--yellow);border:1px solid color-mix(in srgb, var(--yellow) 40%, var(--bg))}
.banner-error{background:color-mix(in srgb, var(--red) 15%, var(--bg));color:var(--red);border:1px solid color-mix(in srgb, var(--red) 40%, var(--bg))}
.banner-success{background:color-mix(in srgb, var(--green) 15%, var(--bg));color:var(--green);border:1px solid color-mix(in srgb, var(--green) 40%, var(--bg))}
.banner ul{margin:6px 0 0 18px}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:12px}
thead{border-radius:6px 6px 0 0;overflow:hidden}
thead th{padding:8px 8px 6px}
th{text-align:left;padding:6px 8px;color:var(--text2);border-bottom:1px solid var(--border);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.4px;background:var(--bg2)}
thead th:first-child{border-radius:6px 0 0 0}
thead th:last-child{border-radius:0 6px 0 0}
td{padding:12px 8px;;vertical-align:top}
tr:hover td{background:var(--bg2)}
input[type=text],select,textarea{width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:4px 6px;border-radius:4px;font-size:12px;font-family:var(--font-mono);outline:none;min-height:30px;}
input[type=text]:focus,select:focus,textarea:focus{border-color:var(--accent)}
input[type=color]{max-width:150px;width:100%;height:30px;padding:0;border:1px solid var(--border);border-radius:4px;background:var(--bg3)}
textarea{resize:vertical;min-height:32px}
.cell-textarea{min-height:30px;height:30px;resize:none;overflow:hidden;line-height:1.8;}
.col-name{width:180px}
.col-type{width:130px}
.col-source{width:110px}
.col-actions{width:70px;text-align:right}
.col-expand{width:48px;padding-left:0px;padding-right:0!important}
.ve-expand-cell{display:flex;align-items:center;gap:2px}
.ve-schema-row-handle{flex-shrink:0;width:18px;height:22px;display:inline-flex;align-items:center;justify-content:center;cursor:grab;color:var(--text3);user-select:none;border:none;background:transparent;font-size:20px;line-height:1;padding:0;letter-spacing:-2px}
.ve-schema-row-handle:hover{color:var(--text2)}
.ve-schema-row-handle:active{cursor:grabbing}
tr.schema-row.is-dragging td,tr.details-row.is-dragging td{opacity:.45}
tr.schema-row.is-drop-target td,tr.details-row.is-drop-target td{box-shadow:inset 0 2px 0 var(--accent)}
.ve-expand-btn{width:30px;height:30px;padding:0;display:inline-flex;align-items:center;justify-content:center;font-size:13px;line-height:1;color:var(--text2)}
.ve-expand-btn:hover{color:var(--text)}
.raw-toggle{margin-bottom:10px}
.raw-editor{width:100%;height:min(60vh,600px);font-family:var(--font-mono);font-size:12px;white-space:pre}
.hint{color:var(--text3);font-size:11px;}
.details-row td{background:var(--bg2);padding:16px}
.details-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
.details-grid-item-wrapper{display:flex;gap:12px;grid-column:1/-1;}
.details-grid label{display:block;font-size:10px;color:var(--text3);text-transform:uppercase;margin-bottom:6px}
.badge{font-size:10px;padding:1px 6px;border-radius:8px;background:var(--bg4);color:var(--text3);text-transform:uppercase;letter-spacing:.3px;white-space:nowrap}
.badge-source-dataset{background:color-mix(in srgb, var(--yellow) 22%, var(--bg));color:var(--yellow)}
.badge-source-static{background:var(--bg4);color:var(--text3)}
.ve-values-layout{display:flex;gap:16px;align-items:stretch;height:calc(100vh - 115px);min-height:320px}
.ve-values-detail > .ve-values-layout{height:100%;min-height:0}
.ve-values-nav{width:280px;flex-shrink:0;display:flex;flex-direction:column;gap:8px;min-height:0}
.ve-values-nav-list{display:flex;flex-direction:column;gap:6px;overflow:auto;min-height:0}
.ve-values-nav-item{display:flex;align-items:center;gap:8px;min-height:30px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg2);color:var(--text);cursor:pointer;text-align:left;width:100%;font-family:var(--font-ui);font-size:12px}
.ve-values-nav-item:hover{border-color:var(--border2);background:var(--bg3)}
.ve-values-nav-item.is-active{border-color:var(--m-accent);background:color-mix(in srgb, var(--m-accent) 12%, var(--m-bg2))}
.ve-values-nav-dot{width:8px;height:8px;border-radius:50%;background:var(--text3);flex-shrink:0}
.ve-values-nav-item.is-active .ve-values-nav-dot{background:var(--m-accent)}
.ve-values-nav-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono)}
.ve-values-nav-badges{display:flex;gap:4px;flex-shrink:0;align-items:center}
.ve-values-nav-add{border-style:dashed;justify-content:center;background:transparent}
.ve-values-nav-add:hover{background:var(--bg3)}
.ve-values-detail{flex:1;min-width:0;overflow:auto;padding-right: 10px}
.ve-values-anchor{scroll-margin-top:12px}
.ve-values-anchor.is-active{border-color:var(--accent)}
.ve-values-anchor + .ve-values-anchor{margin-top:24px;padding-top:10px;}
.ve-values-detail-header{display:flex;align-items:center;gap:8px}
.ve-values-detail-title{font-family:var(--font-mono);font-size:13px;font-weight:600}
.ve-values-detail-header .ve-values-field-label{flex:1;min-width:0}
.ve-values-detail-header .btn{margin-left:auto;flex-shrink:0}
.ve-values-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.ve-values-field{display:flex;flex-direction:column;align-items:flex-start;gap:10px;min-width:0}
.ve-values-field.is-wide{grid-column:1/-1}
.ve-values-field-label{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--text3)}
.ve-values-field-label > span:first-child{font-family:var(--font-mono)}
.ve-values-field textarea,.ve-values-field input[type=text],.ve-values-field select{min-height:30px;height:30px;resize:none;overflow:hidden}
.ve-values-empty{color:var(--text3);padding:24px 0}
.ve-values-list-items{display:flex;flex-direction:column;gap:12px}
.ve-values-list-item{background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:10px 8px 16px;display:flex;gap:6px;align-items:flex-start;transition:opacity .12s ease,border-color .12s ease,box-shadow .12s ease}
.ve-values-list-item.is-dragging{opacity:.45}
.ve-values-list-item.is-drop-target{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.ve-values-list-item-handle{flex-shrink:0;width:22px;align-self:stretch;display:inline-flex;align-items:center;justify-content:center;cursor:grab;color:var(--text3);user-select:none;border:none;background:transparent;font-size:16px;line-height:1;padding:0;letter-spacing:-2px}
.ve-values-list-item-handle:hover{color:var(--text2)}
.ve-values-list-item-handle:active{cursor:grabbing}
.ve-values-list-item > .ve-values-fields{flex:1;min-width:0}
.checkbox-row{display:flex;flex-wrap:wrap;gap:4px 16px}
.details-grid .checkbox-label{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--text2);text-transform:none;margin-bottom:0}
.checkbox-label input{width:auto}
.empty-state{color:var(--text3);text-align:center;padding:40px}
.ve-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:100}
.ve-modal{background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:16px;width:min(400px,90vw);box-shadow:0 8px 24px rgba(0,0,0,.4);position:relative}
.ve-modal-diff{width:min(860px,94vw);min-width:min(500px,90vw);min-height:min(300px,80vh);max-height:85vh;display:flex;flex-direction:column}
.ve-modal-wide{width:min(560px,90vw)}
.ve-modal-title{font-size:12px;color:var(--text2);margin-bottom:8px}
.ve-modal-title-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}
.ve-modal-title-row .ve-modal-title{margin-bottom:0;flex:1}
.ve-modal-close{width:28px;height:28px;padding:0;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
.ve-modal-body{font-size:12px;line-height:1.6;max-height:60vh;overflow-y:auto}
.ve-modal-diff .ve-modal-body{flex:1;max-height:none;min-height:0;display:flex;flex-direction:column;gap:8px}
.ve-diff-nav{display:flex;align-items:center;gap:8px;flex-shrink:0}
.ve-diff-nav .btn{min-width:30px;min-height:30px;padding:0;display:inline-flex;align-items:center;justify-content:center}
.ve-diff-nav-count{font-size:12px;color:var(--text2);font-variant-numeric:tabular-nums;min-width:4.5em}
.ve-diff{background:var(--bg);border:1px solid var(--border);border-radius:6px;overflow:auto;flex:1;min-height:180px;font-family:var(--font-mono);font-size:11px;line-height:1.55}
.ve-diff-line{display:flex;gap:8px;padding:1px 8px;white-space:pre-wrap;word-break:break-word}
.ve-diff-prefix{flex-shrink:0;width:12px;user-select:none;opacity:.8}
.ve-diff-line.is-add{background:color-mix(in srgb, var(--green) 14%, var(--bg));color:var(--text)}
.ve-diff-line.is-remove{background:color-mix(in srgb, var(--red) 14%, var(--bg));color:var(--text)}
.ve-diff-line.is-add .ve-diff-prefix{color:var(--green)}
.ve-diff-line.is-remove .ve-diff-prefix{color:var(--red)}
.ve-diff-line.is-current-change{outline:1px solid var(--accent);outline-offset:-1px;}
.ve-diff-inline-add{background:color-mix(in srgb, var(--green) 35%, transparent);color:var(--green);font-weight:700;border-radius:2px}
.ve-diff-inline-remove{background:color-mix(in srgb, var(--red) 35%, transparent);color:color-mix(in srgb, var(--red) 80%, #fff);font-weight:700;border-radius:2px}
.ve-diff-empty{padding:24px;color:var(--text3);text-align:center}
.ve-modal-body pre{background:var(--bg3);border:1px solid var(--border);border-radius:4px;padding:8px;font-family:var(--font-mono);font-size:11px;white-space:pre-wrap;word-break:break-word}
.ve-modal-body code{background:var(--bg3);padding:1px 4px;border-radius:3px;font-family:var(--font-mono)}
.ve-modal-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:12px}
.ve-modal-actions .hint{margin:0;margin-right:auto;text-align:left}
.ve-combo{position:relative}
.ve-combo-input{margin-bottom:0}
.ve-combo-list{position:absolute;left:0;right:0;top:100%;z-index:10;max-height:220px;overflow-y:auto;background:var(--bg3);border:1px solid var(--border2);border-radius:4px;margin-top:2px;box-shadow:0 4px 12px rgba(0,0,0,.3)}
.ve-combo-option{padding:5px 8px;font-size:12px;cursor:pointer}
.ve-combo-option:hover{background:var(--bg4)}
.ve-combo-chips{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}
.ve-chip{display:inline-flex;align-items:center;gap:4px;background:var(--bg3);border:1px solid var(--border2);border-radius:10px;padding:2px 4px 2px 8px;font-size:11px}
.ve-chip button{background:none;border:none;color:var(--text3);cursor:pointer;font-size:11px;padding:0 2px}
.ve-chip button:hover{color:var(--text)}
.ve-list-items{display:flex;flex-direction:column;gap:6px}
.ve-list-item{display:flex;gap:6px;align-items:flex-start}
.ve-list-item > input[type=text]{flex:1}
.ve-list-item-cols{background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:8px;display:flex;gap:8px;align-items:flex-start}
.ve-list-item-fields{display:flex;flex-direction:column;gap:8px;width:100%}
.ve-list-field{display:flex;flex-direction:column;gap:6px;max-width:450px;width:100%;}
.ve-list-field label{font-size:10px;color:var(--text3);}
.ve-list-field textarea,.ve-list-field input[type=text],.ve-list-field select{min-height:30px;height:30px;resize:none;overflow:hidden}
.ve-list-item-actions{flex-shrink:0}
.box-style{border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--bg3)}
.ve-ao-columns{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.ve-ao-column{background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:10px 8px 16px;display:flex;gap:6px;align-items:flex-start;transition:opacity .12s ease,border-color .12s ease,box-shadow .12s ease}
.ve-ao-column.is-dragging{opacity:.45}
.ve-ao-column.is-drop-target{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.ve-ao-column-handle{flex-shrink:0;width:22px;align-self:stretch;display:inline-flex;align-items:center;justify-content:center;cursor:grab;color:var(--text3);user-select:none;border:none;background:transparent;font-size:16px;line-height:1;padding:0;letter-spacing:-2px}
.ve-ao-column-handle:hover{color:var(--text2)}
.ve-ao-column-handle:active{cursor:grabbing}
.ve-ao-column-fields{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.ve-ao-column-top{display:flex;gap:6px;align-items:flex-end}
.ve-ao-column-field{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.ve-ao-column-field label{font-size:10px;color:var(--text3);text-transform:none;margin-bottom:0;font-family:var(--font-mono)}
.ve-ao-column-name{position:relative;min-width:0}
.ve-ao-column-name input{width:100%;padding-right:28px;font-family:var(--font-mono)}
.ve-ao-column-remove{position:absolute;right:0px;top:50%;transform:translateY(-50%);width:24px;height:24px;padding:0;display:inline-flex;align-items:center;justify-content:center}
.ve-ao-column-bottom{display:flex;gap:6px;align-items:flex-end}
.ve-ao-column-bottom > .ve-ao-column-field{flex:1;min-width:0}
.ve-json-issues{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.ve-json-issue-badge{display:inline-flex;align-items:center;gap:4px;background:color-mix(in srgb, var(--yellow) 15%, var(--bg));color:var(--yellow);border:1px solid color-mix(in srgb, var(--yellow) 40%, var(--bg));border-radius:10px;padding:2px 8px;font-size:11px;cursor:default}
.ve-modal-back{background:none;border:none;color:var(--accent);font-size:11px;cursor:pointer;padding:0 0 4px;font-family:var(--font-ui);display:block}
.ve-import-search{position:relative;margin-bottom:12px}
.ve-import-search input{padding-left:28px}
.ve-import-search::before{content:"⌕";position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--text3);font-size:14px;pointer-events:none}
.ve-import-section-title{font-size:10.5px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin:14px 0 6px;font-weight:600}
.ve-import-section-title:first-child{margin-top:0}
.ve-import-page-list{display:flex;flex-direction:column;gap:5px}
.ve-import-page-row{display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg3);color:var(--text);cursor:pointer;font-family:var(--font-ui);font-size:12px}
.ve-import-page-row:hover{border-color:var(--accent)}
.ve-import-page-name{font-weight:500}
.ve-import-page-slug{font-size:11px;color:var(--text3);font-family:var(--font-mono);margin-left:auto;flex-shrink:0}
.ve-import-empty{padding:20px 4px;text-align:center;color:var(--text3);font-size:12px}
.ve-import-list-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.ve-import-list-head .badge{background:color-mix(in srgb, var(--green) 18%, var(--bg));color:var(--green)}
.ve-import-select-all{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--text2);cursor:pointer;text-transform:none}
.ve-import-list{display:flex;flex-direction:column;gap:6px}
.ve-import-row{display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg3);cursor:pointer}
.ve-import-row input[type=checkbox]{margin-top:2px;flex-shrink:0}
.ve-import-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.ve-import-row-top{display:flex;align-items:center;gap:8px}
.ve-import-row-name{font-family:var(--font-mono);font-size:12px;font-weight:600}
.ve-import-row-value{font-size:11.5px;color:var(--text2);font-family:var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ve-import-swatch{width:12px;height:12px;border-radius:3px;border:1px solid var(--border2);flex-shrink:0;display:inline-block;vertical-align:-1px;margin-right:5px}
.ve-import-skip-row{display:flex;align-items:baseline;gap:8px;padding:7px 10px;opacity:.85}
.ve-import-skip-row .ve-import-row-name{color:var(--text2)}
.ve-import-skip-reason{font-size:11.5px;color:var(--text3)}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--bg4);border-radius:4px}
</style>
</head>
<body>
<div class="app">
  <div class="toolbar">
    <span class="toolbar-title">🧩 Variables Editor</span>
    ${
      templateLess
        ? ''
        : `<div class="tabs">
      <button class="tab" id="tab-schema" onclick="switchTab('schema')">Schema</button>
      <button class="tab" id="tab-values" onclick="switchTab('values')">Values</button>
    </div>`
    }
    ${templateLess ? '' : `<span class="ve-loading-indicator" id="loading-indicator" style="display:none"><span class="ve-loading-dot"></span>Refreshing…</span>`}
    <div class="toolbar-spacer"></div>
    ${
      templateLess
        ? ''
        : `<button class="btn btn-sm" onclick="refresh()">↻ Refresh</button>
    <button class="btn btn-sm btn-primary" id="save-btn" onclick="save()">Save</button>`
    }
    <div class="theme-switch" id="theme-switch">
      <button data-theme-choice="auto" aria-pressed="false" onclick="setTheme('auto')">Auto</button>
      <button data-theme-choice="dark" aria-pressed="false" onclick="setTheme('dark')">Dark</button>
      <button data-theme-choice="light" aria-pressed="false" onclick="setTheme('light')">Light</button>
    </div>
  </div>
  <div class="content" id="content">${
    templateLess
      ? '<div class="empty-state">This page has no associated template — there\'s no <code>__template_variables.json</code> and no page variables to edit here.</div>'
      : ''
  }</div>
</div>
<script>
(function(){
'use strict';

// ── Theme (Auto/Dark/Light) ──────────────────────────────────────────────────
// Runs unconditionally — before the templateLess early-return below — so the switcher works
// even on the info-only page. The <head> inline script already set data-pp-dev-theme before
// first paint; this just keeps it in sync with future picks and syncs the toolbar buttons'
// state. Shares its localStorage key and attribute name with the dev panel and the Request
// Inspector, so picking a theme in any of them carries over to the others.
var THEME_STORAGE_KEY = 'pp-dev-info-theme';

function getStoredTheme() {
  try { return localStorage.getItem(THEME_STORAGE_KEY) || 'auto'; } catch (e) { return 'auto'; }
}

function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.setAttribute('data-pp-dev-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-pp-dev-theme');
  }

  var switchEl = document.getElementById('theme-switch');

  if (switchEl) {
    Array.prototype.forEach.call(switchEl.children, function (btn) {
      var isActive = btn.dataset.themeChoice === theme;

      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
    });
  }
}

function setTheme(theme) {
  try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch (e) {}

  applyTheme(theme);
}

applyTheme(getStoredTheme());
window.setTheme = setTheme;

// Server-rendered above: no tabs, no Refresh/Save, just the message — nothing here to wire up.
if (${templateLess ? 'true' : 'false'}) { return; }

const KNOWN_TYPES = ['text','select','multiselect','file','list','color','boolean'];
const KNOWN_TAG_SOURCES = ['static','page','element','folder','segment','dataset','dataset_data','announcement','group','category','custom_attribute','page_entity'];
// select/multiselect sources whose options are hand-entered via additional_options rather than
// loaded live from MI (the rest — dataset/announcement/group/category/custom_attribute/page/
// page_entity — populate their own option list, so additional_options doesn't apply there).
const HAND_ENTERED_OPTION_SOURCES = ['static','segment','element','dataset_data'];
// list-tag column editor: field types + sources allowed on a select/multi-select column.
const LIST_COLUMN_TYPES = ['textarea','select','multi-select','color','file'];
const LIST_COLUMN_SOURCES = ['static','dataset','group','category','custom_attribute'];
// Matches MI's own "Create/Edit Variable" form: letters, digits, underscore, whitespace, hyphen.
// Doubled backslash: this sits inside getVariablesEditorHtml()'s outer template literal, which
// consumes one level of backslash-escaping when the .ts source is parsed — a bare \s here would
// collapse to a literal "s", silently dropping whitespace from the allowed character class (see
// the identical pitfall fixed for escapeJsAttr() below).
const NAME_FORMAT_REGEX = /^[A-Za-z0-9_\\s-]+$/;
// Lets a link like /@pp-dev/variables-editor?tab=values open directly on that tab.
function tabFromUrl() {
  return new URLSearchParams(window.location.search).get('tab') === 'values' ? 'values' : 'schema';
}

// Values tab's raw/JSON mode is also linkable — /@pp-dev/variables-editor?tab=values&mode=json.
function valuesJsonModeFromUrl() {
  return new URLSearchParams(window.location.search).get('mode') === 'json';
}

function setUrlState(tab, valuesJsonMode) {
  const url = new URL(window.location.href);

  url.searchParams.set('tab', tab);

  if (tab === 'values' && valuesJsonMode) {
    url.searchParams.set('mode', 'json');
  } else {
    url.searchParams.delete('mode');
  }

  history.replaceState(null, '', url);
}

let activeTab = tabFromUrl();
let schemaState = null;   // { exists, schema, raw, parseError }
let valuesState = null;   // { schema, live, combined }
let schemaRows = [];      // working copy of tags, edited in place
const invalidAdditionalOptionsRows = new WeakSet();
let valueRows = [];       // working copy of {name, value}
let selectedValueIndex = 0;
let selectedListItemIndex = 0;
let importReviewCandidates = []; // last-fetched import-plan's "importable" list, for applyImportPlan()
let importReviewPageName = '';   // source page name, for the post-apply banner
let valuesRawMode = activeTab === 'values' && valuesJsonModeFromUrl();
let rawMode = false;
let dirty = false;
let editSeq = 0;
let banner = null;
// Last-known saved JSON for each tab — used to build the post-save GitHub-style diff.
let jsonBaseline = { schema: '', values: '' };

// Background-refresh bookkeeping, one pair of (loading flag, sequence counter) per tab: a
// stale response (superseded by a newer load for the SAME tab before it resolved) is dropped
// rather than clobbering fresher data — see loadTabData().
let schemaLoading = false;
let valuesLoading = false;
let schemaSeq = 0;
let valuesSeq = 0;
let autoLoadTimer = null;
const AUTO_LOAD_DEBOUNCE_MS = 200;

const contentEl = document.getElementById('content');

window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

function setDirty(v) {
  dirty = v;

  if (v) { editSeq += 1; }
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Escapes a value for embedding inside a single-quoted JS string literal that itself sits
// inside an HTML attribute (e.g. onclick="fn('...')") — schema-derived names (column names,
// tag names) aren't trusted local input, since the schema can come from a server backup ZIP
// (see DistService.saveTemplateVariablesFile). Backslash/quote-escape for the JS-string
// context first, then HTML-escape the result so it can't break out of the attribute either.
function escapeJsAttr(s) {
  return escapeHtml(String(s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'"));
}

function showBanner(type, html, preserveContent) {
  banner = { type, html };

  if (preserveContent) {
    const existingBanner = contentEl.querySelector(':scope > .banner');
    const bannerEl = document.createElement('div');

    if (existingBanner) { existingBanner.remove(); }

    bannerEl.className = 'banner banner-' + type;
    bannerEl.innerHTML = html;
    contentEl.prepend(bannerEl);

    return;
  }

  render();
}

function clearBanner() { banner = null; }

// Shown in place of a tab's content while it's never been loaded yet (first visit, or right
// after a hard refresh of the page) — as opposed to ve-loading-indicator, which is for a
// background reload of a tab that already has cached content on screen.
function renderSkeleton() {
  let rows = '';

  for (let i = 0; i < 5; i++) { rows += '<div class="ve-skeleton-row"></div>'; }

  return '<div class="ve-skeleton">' + rows + '</div>';
}

// ── Data loading ─────────────────────────────────────────────────────────────
async function loadSchema(seq) {
  let data;

  try {
    const r = await fetch('/@api/variables/schema');

    data = await r.json();
  } catch (e) {
    if (seq !== schemaSeq) { return; }

    showBanner('error', 'Failed to load the schema: ' + escapeHtml(e.message));

    return;
  }

  if (seq !== schemaSeq) { return; }

  schemaState = data;
  schemaRows = (data.schema && Array.isArray(data.schema.tags)) ? data.schema.tags.map((t) => Object.assign({}, t)) : [];
  rawMode = data.exists && !data.schema;
  jsonBaseline.schema = snapshotSchemaJson();
}

async function loadValues(seq) {
  let r;

  try {
    r = await fetch('/@api/variables/values');
  } catch (e) {
    if (seq !== valuesSeq) { return; }

    valuesState = null;
    valueRows = [];
    showBanner('error', 'Failed to load values: ' + escapeHtml(e.message));

    return;
  }

  if (!r.ok) {
    const err = await r.json().catch(() => ({}));

    if (seq !== valuesSeq) { return; }

    // A save is a full replacement. Keep the state explicitly unavailable after a failed
    // read so the user cannot accidentally submit an empty replacement set.
    valuesState = null;
    valueRows = [];
    showBanner('error', escapeHtml(err.error || 'Failed to load values.'));

    return;
  }

  let data;

  try {
    data = await r.json();
  } catch (e) {
    if (seq !== valuesSeq) { return; }

    valuesState = null;
    valueRows = [];
    showBanner('error', 'Failed to parse the values response: ' + escapeHtml(e.message));

    return;
  }

  if (seq !== valuesSeq) { return; }

  valuesState = data;
  valueRows = (data.combined || []).map((e) => Object.assign({}, e));
  jsonBaseline.values = snapshotValuesJson();
}

function snapshotSchemaJson() {
  if (!schemaState) { return ''; }

  if (rawMode) {
    const editorEl = document.getElementById('raw-editor');

    return editorEl ? editorEl.value : (schemaState.raw || '');
  }

  if (schemaState.raw && (!schemaState.schema || !Array.isArray(schemaRows))) {
    return schemaState.raw;
  }

  try {
    return JSON.stringify(Object.assign({}, schemaState.schema || {}, { tags: schemaRows }), null, 2);
  } catch (e) {
    return schemaState.raw || '';
  }
}

function snapshotValuesJson(rows) {
  try {
    return JSON.stringify(toExportableValueRows(rows || valueRows), null, 2);
  } catch (e) {
    return '[]';
  }
}

function normalizeJsonText(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch (e) {
    return String(text || '');
  }
}

// Longest common subsequence line indices — small enough for template-variable JSON files.
function lcsLineMatrix(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  return dp;
}

function computeLineDiff(beforeText, afterText) {
  // Doubled backslash: outer getVariablesEditorHtml() template literal consumes one level.
  const a = String(beforeText || '').split('\\n');
  const b = String(afterText || '').split('\\n');
  const dp = lcsLineMatrix(a, b);
  const lines = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ type: 'equal', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: 'remove', text: a[i] });
      i++;
    } else {
      lines.push({ type: 'add', text: b[j] });
      j++;
    }
  }

  while (i < a.length) {
    lines.push({ type: 'remove', text: a[i++] });
  }

  while (j < b.length) {
    lines.push({ type: 'add', text: b[j++] });
  }

  // Pair adjacent remove+add as inline-highlighted changes.
  const paired = [];

  for (let k = 0; k < lines.length; k++) {
    const cur = lines[k];
    const next = lines[k + 1];

    if (cur.type === 'remove' && next && next.type === 'add') {
      paired.push({ type: 'remove', text: cur.text, pair: next.text });
      paired.push({ type: 'add', text: next.text, pair: cur.text });
      k++;
    } else {
      paired.push(cur);
    }
  }

  return paired;
}

function inlineDiffHtml(text, pair, mode) {
  if (pair == null || pair === text) {
    return escapeHtml(text);
  }

  let start = 0;
  const minLen = Math.min(text.length, pair.length);

  while (start < minLen && text.charAt(start) === pair.charAt(start)) {
    start++;
  }

  let endOld = text.length;
  let endNew = pair.length;

  while (endOld > start && endNew > start && text.charAt(endOld - 1) === pair.charAt(endNew - 1)) {
    endOld--;
    endNew--;
  }

  const before = escapeHtml(text.slice(0, start));
  const mid = escapeHtml(text.slice(start, endOld));
  const after = escapeHtml(text.slice(endOld));
  const cls = mode === 'add' ? 've-diff-inline-add' : 've-diff-inline-remove';

  return before + (mid ? '<span class="' + cls + '">' + mid + '</span>' : '') + after;
}

function renderJsonDiffHtml(beforeText, afterText) {
  const before = normalizeJsonText(beforeText);
  const after = normalizeJsonText(afterText);

  if (before === after) {
    return { html: '<div class="ve-diff-empty">No differences in the JSON file.</div>', changeCount: 0 };
  }

  const lines = computeLineDiff(before, after);
  let changeCount = 0;
  let inHunk = false;

  const html = '<div class="ve-diff">' + lines.map((line) => {
    if (line.type === 'equal') {
      inHunk = false;

      return '<div class="ve-diff-line"><span class="ve-diff-prefix"> </span><span>' + escapeHtml(line.text) + '</span></div>';
    }

    const attrs = !inHunk
      ? ' data-change-index="' + changeCount + '"'
      : '';

    if (!inHunk) {
      changeCount++;
      inHunk = true;
    }

    if (line.type === 'remove') {
      return '<div class="ve-diff-line is-remove"' + attrs + '><span class="ve-diff-prefix">-</span><span>' +
        inlineDiffHtml(line.text, line.pair, 'remove') + '</span></div>';
    }

    return '<div class="ve-diff-line is-add"' + attrs + '><span class="ve-diff-prefix">+</span><span>' +
      inlineDiffHtml(line.text, line.pair, 'add') + '</span></div>';
  }).join('') + '</div>';

  return { html: html, changeCount: changeCount };
}

function showJsonDiffModal(beforeText, afterText, onConfirm) {
  const diff = renderJsonDiffHtml(beforeText, afterText);
  const hasChanges = diff.changeCount > 0;
  const overlay = document.createElement('div');

  overlay.className = 've-modal-overlay';
  overlay.innerHTML =
    '<div class="ve-modal ve-modal-diff" role="dialog" aria-modal="true">' +
      '<div class="ve-modal-title-row">' +
        '<div class="ve-modal-title">JSON changes</div>' +
        '<button type="button" class="btn btn-sm ve-modal-close" title="Close" aria-label="Close">✕</button>' +
      '</div>' +
      '<div class="ve-modal-body">' +
        (hasChanges
          ? '<div class="ve-diff-nav">' +
              '<button type="button" class="btn btn-sm ve-diff-prev" title="Previous change" aria-label="Previous change">←</button>' +
              '<button type="button" class="btn btn-sm ve-diff-next" title="Next change" aria-label="Next change">→</button>' +
              '<span class="ve-diff-nav-count">1 / ' + diff.changeCount + '</span>' +
            '</div>'
          : '') +
        diff.html +
      '</div>' +
      '<div class="ve-modal-actions">' +
        '<div class="hint">Review added (+) and removed (−) lines, including inline highlights for changed segments.</div>' +
        '<button type="button" class="btn btn-sm ve-modal-cancel">Cancel</button>' +
        '<button type="button" class="btn btn-sm btn-primary ve-modal-ok">Save Changes</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);
  overlay.querySelector('.ve-modal-ok').focus();

  let currentChange = 0;

  function updateChangeNav() {
    const countEl = overlay.querySelector('.ve-diff-nav-count');
    const prevBtn = overlay.querySelector('.ve-diff-prev');
    const nextBtn = overlay.querySelector('.ve-diff-next');
    const diffEl = overlay.querySelector('.ve-diff');

    if (!hasChanges || !diffEl) { return; }

    Array.prototype.forEach.call(diffEl.querySelectorAll('.ve-diff-line.is-current-change'), function (el) {
      el.classList.remove('is-current-change');
    });

    const target = diffEl.querySelector('.ve-diff-line[data-change-index="' + currentChange + '"]');

    if (target) {
      target.classList.add('is-current-change');
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    if (countEl) {
      countEl.textContent = (currentChange + 1) + ' / ' + diff.changeCount;
    }

    if (prevBtn) { prevBtn.disabled = currentChange <= 0; }
    if (nextBtn) { nextBtn.disabled = currentChange >= diff.changeCount - 1; }
  }

  if (hasChanges) {
    overlay.querySelector('.ve-diff-prev').addEventListener('click', function () {
      if (currentChange > 0) {
        currentChange--;
        updateChangeNav();
      }
    });
    overlay.querySelector('.ve-diff-next').addEventListener('click', function () {
      if (currentChange < diff.changeCount - 1) {
        currentChange++;
        updateChangeNav();
      }
    });
    // Wait a frame so the modal layout is ready before scrolling.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { updateChangeNav(); });
    }
  }

  function close(confirmed) {
    overlay.remove();

    if (confirmed && typeof onConfirm === 'function') {
      onConfirm();
    }
  }

  overlay.querySelector('.ve-modal-ok').addEventListener('click', () => close(true));
  overlay.querySelector('.ve-modal-cancel').addEventListener('click', () => close(false));
  overlay.querySelector('.ve-modal-close').addEventListener('click', () => close(false));
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) { close(false); }
  });
  overlay.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowLeft' && hasChanges) {
      ev.preventDefault();

      if (currentChange > 0) {
        currentChange--;
        updateChangeNav();
      }

      return;
    }

    if (ev.key === 'ArrowRight' && hasChanges) {
      ev.preventDefault();

      if (currentChange < diff.changeCount - 1) {
        currentChange++;
        updateChangeNav();
      }

      return;
    }

    if (ev.key === 'Enter') {
      ev.preventDefault();
      close(true);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      close(false);
    }
  });
}

// Fetches fresh data for one tab, tracking a per-tab "loading" flag and sequence number so a
// response that's superseded by a newer load for the SAME tab (started before this one
// resolved) gets dropped instead of clobbering fresher data. Toggles the tab's own loading
// flag but deliberately doesn't call render() itself — callers decide when to repaint.
function loadTabData(tab) {
  if (tab === 'schema') {
    const seq = ++schemaSeq;

    schemaLoading = true;

    return loadSchema(seq).then(() => {
      if (seq === schemaSeq) { schemaLoading = false; }
    });
  }

  const seq = ++valuesSeq;

  valuesLoading = true;

  return loadValues(seq).then(() => {
    if (seq === valuesSeq) { valuesLoading = false; }
  });
}

// The manual "↻ Refresh" button — deliberately NOT debounced, so it's always the fast path
// for "I just changed something in MI and want it now" (see scheduleAutoLoad for the
// debounced, tab-switch-driven path).
async function doRefresh() {
  clearBanner();
  setDirty(false);

  // loadTabData() flips the tab's loading flag synchronously before its fetch resolves, so
  // render() has to run AFTER that call starts (not before) for the indicator to reflect it.
  const pending = loadTabData(activeTab);

  render();
  await pending;
  render();
}

function refresh() {
  if (dirty) {
    showConfirmModal('Discard unsaved changes?', doRefresh);

    return;
  }

  doRefresh();
}

// Debounces the network round-trip that automatically follows a tab switch: rapidly flipping
// between tabs (or landing on one only to immediately leave it) only fires the load that's
// still pending once things settle, rather than one request per click.
function scheduleAutoLoad(tab) {
  if (autoLoadTimer) { clearTimeout(autoLoadTimer); }

  autoLoadTimer = setTimeout(() => {
    autoLoadTimer = null;

    // loadTabData() flips the tab's loading flag synchronously before its fetch resolves, so
    // render() has to run AFTER this call starts (not before) for the indicator to reflect it.
    const pending = loadTabData(tab);

    if (activeTab === tab) { render(); }

    pending.then(() => {
      if (activeTab === tab) { render(); }
    });
  }, AUTO_LOAD_DEBOUNCE_MS);
}

function doSwitchTab(tab) {
  activeTab = tab;
  setDirty(false);
  clearBanner();

  // Switching tabs by hand always starts the Values tab in table view — only a direct link
  // (?tab=values&mode=json, handled at bootstrap) opens straight into raw/JSON mode.
  if (tab === 'values') { valuesRawMode = false; }

  setUrlState(tab, valuesRawMode);

  document.getElementById('tab-schema').classList.toggle('active', tab === 'schema');
  document.getElementById('tab-values').classList.toggle('active', tab === 'values');

  // Paint immediately with whatever's already cached for this tab (or a skeleton, if it's
  // never been loaded) instead of leaving the previous tab's content on screen until the
  // debounced fetch below resolves.
  render();
  scheduleAutoLoad(tab);
}

function switchTab(tab) {
  if (dirty) {
    showConfirmModal('Discard unsaved changes and switch tabs?', () => doSwitchTab(tab));

    return;
  }

  doSwitchTab(tab);
}

// ── Schema tab ───────────────────────────────────────────────────────────────

// A styled <select> (not a native <datalist>, whose popup/selected-state styling browsers
// won't let us theme) with an escape hatch: picking "Custom…" prompts for any string, so a
// tag_type/tag_source MI adds in the future can be configured here without a pp-dev code change.
const CUSTOM_TYPE_SENTINEL = '__custom__';

function customSelectCell(field, knownValues, fallback, tag, i) {
  const currentValue = tag[field] || fallback;
  const isKnown = knownValues.includes(currentValue);
  const knownOptions = knownValues.map((v) =>
    '<option value="' + v + '"' + (currentValue === v ? ' selected' : '') + '>' + v + '</option>',
  ).join('');
  const customOption = !currentValue || isKnown
    ? ''
    : '<option value="' + escapeHtml(currentValue) + '" selected>' + escapeHtml(currentValue) + ' (custom)</option>';

  return (
    '<select onchange="onCustomSelectChange(' + i + ',this,\\'' + field + '\\')">' +
    knownOptions +
    customOption +
    '<option value="' + CUSTOM_TYPE_SENTINEL + '">Custom…</option>' +
    '</select>'
  );
}

function typeSelectCell(tag, i) {
  return customSelectCell('tag_type', KNOWN_TYPES, 'text', tag, i);
}

function tagSourceSelectCell(tag, i) {
  return customSelectCell('tag_source', KNOWN_TAG_SOURCES, '', tag, i);
}

// Short, one-line version for inline display next to the field — click "?" for the full
// per-tag_source breakdown (additionalOptionsDetails()) with examples, shown in a modal.
function additionalOptionsHint(tag) {
  const tagType = tag.tag_type;

  if (tagType === 'select' || tagType === 'multiselect') {
    const source = tag.tag_source || 'static';

    if (source === 'static') { return 'The option list itself.'; }
    if (source === 'dataset_data') { return 'Which dataset + columns to pull options from.'; }
    if (source === 'element') { return 'Optional filter by element type.'; }
    if (source === 'segment') { return 'Accepted by MI\\'s form, but not read for this source.'; }

    return 'Not used for tag_source "' + escapeHtml(source) + '" — MI loads its options live.';
  }

  if (tagType === 'list') {
    return 'Column definitions for list-of-objects items, or "" for a flat list of strings.';
  }

  if (tagType === 'boolean') {
    return 'Not used for tag_type "boolean".';
  }

  return 'No confirmed runtime use for tag_type "' + escapeHtml(tagType || 'text') + '".';
}

// Full breakdown with examples, reverse-engineered from MI's own options-loading logic —
// shown in a modal (showAdditionalOptionsHelp()) so the inline hint above can stay short.
function additionalOptionsDetails(tag) {
  const tagType = tag.tag_type;

  if (tagType === 'select' || tagType === 'multiselect') {
    const source = tag.tag_source || 'static';

    if (source === 'static') {
      return '<p>The option list itself. Each entry is a plain string, or an object with <code>id</code>/<code>text</code>:</p>' +
        '<pre>[{"id":"1","text":"One"},"Two"]</pre>' +
        '<p>A plain string entry uses itself as both the stored value and the label.</p>';
    }

    if (source === 'dataset_data') {
      return '<p>Pulls options live from a dataset, by column name:</p>' +
        '<pre>{"dataset_id":123,"key_column":"id_col","text_column":"name_col"}</pre>' +
        '<p><code>key_column</code> supplies the option value, <code>text_column</code> the label.</p>';
    }

    if (source === 'element') {
      return '<p>Optional — restricts the dashboard-element list to one type:</p>' +
        '<pre>{"type":"metric"}</pre>' +
        '<p>Accepted values: <code>metric</code>, <code>multi-metric chart</code>, <code>internal report</code>, <code>external report</code>, <code>other external content</code>. Leave empty to list all elements.</p>';
    }

    if (source === 'segment') {
      return '<p>MI\\'s own "Create/Edit Variable" form shows this field for tag_source "segment", but its options-loading endpoint never actually reads it — the segment list always comes back unfiltered. Best left empty.</p>';
    }

    return '<p>Not used — for tag_source "' + escapeHtml(source) + '", MI loads options live from its own data (e.g. the dataset/announcement/group/category/page list) and never consults this field.</p>';
  }

  if (tagType === 'list') {
    return '<p>An array of column definitions — each list item becomes an object keyed by these names:</p>' +
      '<pre>[{"name":"id","type":"textarea"},{"name":"color","type":"color"}]</pre>' +
      '<p>A bare string entry is shorthand for <code>{"name": &lt;that string&gt;, "type": "textarea"}</code>. Leave as <code>""</code> (empty string) instead for a flat list of plain strings.</p>' +
      '<p>Supported field <code>type</code>s: <code>textarea</code>, <code>color</code>, <code>select</code>, <code>multi-select</code>, <code>file</code>.</p>' +
      '<p>For a <code>select</code>/<code>multi-select</code> column, add <code>source</code> (defaults to <code>"static"</code>) and <code>options</code> — same per-source rules as the tag-level <code>tag_source</code>/<code>additional_options</code> above, just scoped to this one column and fed by <code>options</code> instead:</p>' +
      '<pre>{"name":"country","type":"select","options":["USA","Canada"]}</pre>' +
      '<p>MI\\'s own list-item editor never reads this column\\'s own <code>additional_options</code> — only <code>options</code> — so leave it out.</p>';
  }

  if (tagType === 'boolean') {
    return '<p>MI\\'s own editor doesn\\'t show this field for tag_type "boolean", and there\\'s no known runtime use for it — leave empty.</p>';
  }

  return '<p>MI\\'s own editor lets you fill this in for tag_type "' + escapeHtml(tagType || 'text') + '", but there\\'s no confirmed runtime consumer for it — treat it as unused/reserved.</p>';
}

function showAdditionalOptionsHelp(i) {
  const tag = schemaRows[i];

  showInfoModal('additional_options — ' + escapeHtml(tag.tag_type || 'text') + (tag.tag_source ? ' / ' + escapeHtml(tag.tag_source) : ''), additionalOptionsDetails(tag));
}

// Mirrors MI's own "Create/Edit Variable" form: which fields it shows/hides depends on
// tag_type (and, for the tag_source picker and additional_options, tag_source too). For a
// tag_type MI hasn't defined yet (i.e. a custom one entered via typeSelectCell's escape hatch),
// there's no such logic to mirror, so give full access to everything instead of guessing.
function fieldVisibility(tag) {
  const type = tag.tag_type;

  if (!KNOWN_TYPES.includes(type)) {
    return { tagSource: true, useHtml: true, rawHtml: true, useJson: true, defaultValue: true, additionalOptions: true };
  }

  const isTextOrList = type === 'text' || type === 'list';
  const isSelectLike = type === 'select' || type === 'multiselect';
  const useHtmlOn = tag.use_hmtl_editor_ind === 'Y';
  const source = tag.tag_source || 'static';

  return {
    tagSource: isSelectLike,
    useHtml: type === 'text',
    rawHtml: isTextOrList && !useHtmlOn,
    useJson: (type === 'text' && !useHtmlOn) || type === 'list',
    defaultValue: isTextOrList,
    additionalOptions:
      type === 'text' || type === 'file' || type === 'list' || type === 'color' ||
      (isSelectLike && HAND_ENTERED_OPTION_SOURCES.indexOf(source) !== -1),
  };
}

function checkboxField(label, checked, onchangeAttr) {
  return '<label class="checkbox-label"><input type="checkbox" ' + (checked ? 'checked' : '') + ' ' + onchangeAttr + ' />' + escapeHtml(label) + '</label>';
}

function editorFlagsRow(tag, i, vis) {
  if (!vis.useHtml && !vis.rawHtml && !vis.useJson) {
    return '';
  }

  const parts = [];

  if (vis.useHtml) {
    parts.push(checkboxField('Use WYSIWYG Editor', tag.use_hmtl_editor_ind === 'Y', 'onchange="updateEditorFlag(' + i + ',\\'use_hmtl_editor_ind\\',this.checked)"'));
  }

  if (vis.rawHtml) {
    parts.push(checkboxField('Raw HTML', tag.use_raw_html_ind === 'Y', 'onchange="updateEditorFlag(' + i + ',\\'use_raw_html_ind\\',this.checked)"'));
  }

  if (vis.useJson) {
    parts.push(checkboxField('Use JSON Editor', tag.use_json_editor_ind === 'Y', 'onchange="updateEditorFlag(' + i + ',\\'use_json_editor_ind\\',this.checked)"'));
  }

  return '<div style="grid-column:1/-1" class="checkbox-row">' + parts.join('') + '</div>';
}

function nameWarningHint(name) {
  if (!name) {
    return '<div class="hint" style="color:var(--red)">Name is required.</div>';
  }

  if (!NAME_FORMAT_REGEX.test(name)) {
    return '<div class="hint" style="color:var(--red)">Contains a character MI\\'s own editor doesn\\'t allow — only letters, digits, underscore, hyphen, and whitespace.</div>';
  }

  return '';
}

// Re-renders the whole schema table (needed because changing tag_type/tag_source/an editor
// flag can change which OTHER fields this same row should show), then restores row i's
// advanced panel to whatever open/closed state it was in — render() always starts it closed.
function rerenderKeepingAdvancedOpen(i) {
  const before = document.getElementById('advanced-' + i);
  const wasOpen = !!before && before.style.display !== 'none';

  render();

  if (wasOpen) {
    const after = document.getElementById('advanced-' + i);
    const btn = document.getElementById('expand-btn-' + i);

    if (after) { after.style.display = ''; }
    if (btn) { btn.textContent = '▾'; btn.setAttribute('aria-expanded', 'true'); }
  }
}

function updateEditorFlag(i, field, checked) {
  schemaRows[i][field] = checked ? 'Y' : 'N';

  // Matches MI's own form: turning WYSIWYG on is exclusive with Raw HTML / JSON Editor.
  if (field === 'use_hmtl_editor_ind' && checked) {
    schemaRows[i].use_raw_html_ind = 'N';
    schemaRows[i].use_json_editor_ind = 'N';
  }

  setDirty(true);
  rerenderKeepingAdvancedOpen(i);
}

// A custom HTML modal instead of window.prompt() — some embedded webviews (e.g. Cursor's
// built-in browser) don't implement native prompt()/confirm() at all, so it just returns null
// immediately with no dialog ever shown. This works identically everywhere.
function showCustomValueModal(title, initialValue, onDone) {
  const overlay = document.createElement('div');

  overlay.className = 've-modal-overlay';
  overlay.innerHTML =
    '<div class="ve-modal">' +
    '<div class="ve-modal-title">' + escapeHtml(title) + '</div>' +
    '<input type="text" class="ve-modal-input" value="' + escapeHtml(initialValue) + '" />' +
    '<div class="ve-modal-actions">' +
    '<button type="button" class="btn btn-sm ve-modal-cancel">Cancel</button>' +
    '<button type="button" class="btn btn-sm btn-primary ve-modal-ok">OK</button>' +
    '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  const inputEl = overlay.querySelector('.ve-modal-input');

  inputEl.focus();
  inputEl.select();

  function close(value) {
    overlay.remove();
    onDone(value);
  }

  overlay.querySelector('.ve-modal-ok').addEventListener('click', () => close(inputEl.value));
  overlay.querySelector('.ve-modal-cancel').addEventListener('click', () => close(null));
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) {
      close(null);
    }
  });
  inputEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      close(inputEl.value);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      close(null);
    }
  });
}

// Same rationale as showCustomValueModal() — window.confirm() is unreliable in some embedded
// webviews, so any "discard unsaved changes?" gate needs to go through this instead.
function showConfirmModal(message, onConfirm) {
  const overlay = document.createElement('div');

  overlay.className = 've-modal-overlay';
  overlay.innerHTML =
    '<div class="ve-modal">' +
    '<div class="ve-modal-title">' + escapeHtml(message) + '</div>' +
    '<div class="ve-modal-actions">' +
    '<button type="button" class="btn btn-sm ve-modal-cancel">Cancel</button>' +
    '<button type="button" class="btn btn-sm btn-primary ve-modal-ok">OK</button>' +
    '</div>' +
    '</div>';

  document.body.appendChild(overlay);
  overlay.querySelector('.ve-modal-ok').focus();

  function close(confirmed) {
    overlay.remove();

    if (confirmed) {
      onConfirm();
    }
  }

  overlay.querySelector('.ve-modal-ok').addEventListener('click', () => close(true));
  overlay.querySelector('.ve-modal-cancel').addEventListener('click', () => close(false));
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) {
      close(false);
    }
  });
  overlay.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      close(true);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      close(false);
    }
  });
}

// A plain info modal (no input, single "Close" action) — used to keep long explanations
// (e.g. additional_options' full per-tag_source breakdown) out of the inline hint text.
function showInfoModal(title, bodyHtml) {
  const overlay = document.createElement('div');

  overlay.className = 've-modal-overlay';
  overlay.innerHTML =
    '<div class="ve-modal ve-modal-wide">' +
    '<div class="ve-modal-title">' + escapeHtml(title) + '</div>' +
    '<div class="ve-modal-body">' + bodyHtml + '</div>' +
    '<div class="ve-modal-actions">' +
    '<button type="button" class="btn btn-sm btn-primary ve-modal-ok">Close</button>' +
    '</div>' +
    '</div>';

  document.body.appendChild(overlay);
  overlay.querySelector('.ve-modal-ok').focus();

  function close() { overlay.remove(); }

  overlay.querySelector('.ve-modal-ok').addEventListener('click', close);
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) { close(); }
  });
  overlay.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  });
}

function onCustomSelectChange(i, selectEl, field) {
  if (selectEl.value !== CUSTOM_TYPE_SENTINEL) {
    updateSchemaField(i, field, selectEl.value);

    // tag_type/tag_source changes can change which other fields this row should show.
    rerenderKeepingAdvancedOpen(i);

    return;
  }

  showCustomValueModal('Custom ' + field + ' value', schemaRows[i][field] || '', (custom) => {
    if (custom) {
      updateSchemaField(i, field, custom);
    }

    // Re-render either way: on success, so the select shows the new custom option instead of
    // "Custom…"; on cancel, so it reverts to the row's actual (unchanged) value.
    rerenderKeepingAdvancedOpen(i);
  });
}

function renderSchemaTab() {
  if (!schemaState) { return renderSkeleton(); }

  if (rawMode) {
    return \`
      <div class="raw-toggle"><button class="btn btn-sm" onclick="toggleRawMode()">Switch to table view</button></div>
      \${schemaState.parseError ? '<div class="banner banner-error">File exists but is not valid JSON: ' + escapeHtml(schemaState.parseError) + '</div>' : ''}
      <textarea class="raw-editor" id="raw-editor" oninput="setDirty(true)">\${escapeHtml(schemaState.raw || '')}</textarea>
      <div class="hint">Editing the raw file text directly. Must be valid JSON with a top-level "tags" array.</div>
    \`;
  }

  if (!schemaState.exists) {
    return \`<div class="empty-state">No local __template_variables.json found.<br><button class="btn btn-sm" style="margin-top:10px" onclick="addSchemaRow()">Create one — add first variable</button></div>\`;
  }

  const rows = schemaRows.map((tag, i) => {
    const vis = fieldVisibility(tag);
    // An empty string means "not set" (the flat-list/no-options convention) — show it as an
    // empty field instead of the literal two-character JSON string '""'.
    const additionalOptionsRaw = tag.additional_options !== undefined && tag.additional_options !== ''
      ? JSON.stringify(tag.additional_options)
      : '';

    const defaultValueCell = vis.defaultValue
      ? '<textarea class="cell-textarea" oninput="autosizeCellTextarea(this);updateSchemaField(' + i + ',\\'default_value\\',this.value)">' + escapeHtml(tag.default_value || '') + '</textarea>'
      : '<textarea class="cell-textarea" disabled title="MI\\'s own editor has no Default Value field for this tag_type.">' + escapeHtml(tag.default_value || '') + '</textarea>';

    const tagSourceCell = vis.tagSource
      ? tagSourceSelectCell(tag, i)
      : '<span class="badge">' + escapeHtml(tag.tag_source || 'static') + '</span> <div class="hint">Only configurable for select/multiselect in MI\\'s own editor.</div>';

    const additionalOptionsCell = vis.additionalOptions
      ? '<textarea id="ao-raw-' + i + '" oninput="updateSchemaAdditionalOptions(' + i + ',this.value)">' + escapeHtml(additionalOptionsRaw) + '</textarea>'
      : '<textarea id="ao-raw-' + i + '" disabled title="Not used for this tag_type/tag_source combination in MI\\'s own editor.">' + escapeHtml(additionalOptionsRaw) + '</textarea>';

    const listColumnsEditor = tag.tag_type === 'list' ? listColumnsEditorHtml(tag, i) : '';

    return \`
    <tr class="schema-row" data-row-index="\${i}" ondragover="onSchemaRowDragOver(event)" ondrop="onSchemaRowDrop(event)" ondragleave="onSchemaRowDragLeave(event)">
      <td class="col-expand">
        <div class="ve-expand-cell">
          <span class="ve-schema-row-handle" draggable="true" ondragstart="onSchemaRowDragStart(event)" ondragend="onSchemaRowDragEnd(event)" title="Drag to reorder" aria-label="Drag to reorder" role="button" tabindex="0">⠿</span>
          <button class="btn btn-sm ve-expand-btn" id="expand-btn-\${i}" onclick="toggleSchemaAdvanced(\${i})" aria-expanded="false" title="Advanced fields (uid, tag_source, additional_options, editor flags)">▸</button>
        </div>
      </td>
      <td class="col-name">
        <input type="text" value="\${escapeHtml(tag.name || '')}" oninput="updateSchemaField(\${i},'name',this.value)" />
        \${nameWarningHint(tag.name)}
      </td>
      <td class="col-type">\${typeSelectCell(tag, i)}</td>
      <td>\${defaultValueCell}</td>
      <td><textarea class="cell-textarea" oninput="autosizeCellTextarea(this);updateSchemaField(\${i},'description',this.value)">\${escapeHtml(tag.description || '')}</textarea></td>
      <td class="col-actions">
        <button class="btn btn-sm" onclick="removeSchemaRow(\${i})">✕</button>
      </td>
    </tr>
    <tr class="details-row" id="advanced-\${i}" data-row-index="\${i}" style="display:none;" ondragover="onSchemaRowDragOver(event)" ondrop="onSchemaRowDrop(event)" ondragleave="onSchemaRowDragLeave(event)">
      <td colspan="6" style="border:none;">
        <div class="details-grid">
          <div class="details-grid-item-wrapper">
            <div class="box-style"><label>uid</label><input type="text" value="\${escapeHtml(tag.uid || '')}" oninput="updateSchemaField(\${i},'uid',this.value)" /></div>
            <div class="box-style"><label>tag_source</label>\${tagSourceCell}</div>
            <div class="box-style" style="height:fit-content;">\${editorFlagsRow(tag, i, vis)}</div>
          </div>
          <div class="box-style" style="grid-column:1/-1">
            <label>additional_options (raw JSON) <button type="button" class="btn btn-sm" style="text-transform:none;padding:0 6px;margin-left:4px" onclick="showAdditionalOptionsHelp(\${i})" title="What goes here for this type/source?">?</button></label>
            \${additionalOptionsCell}
            <div class="hint">\${additionalOptionsHint(tag)}</div>
            
          </div>
          \${listColumnsEditor}
        </div>
      </td>
    </tr>
  \`;
  }).join('');

  return \`
    <div class="raw-toggle"><button class="btn btn-sm" onclick="toggleRawMode()">View/edit raw JSON</button></div>
    <table>
      <thead><tr><th class="col-expand"></th><th class="col-name">Name</th><th class="col-type">Type</th><th>Default value</th><th>Description</th><th class="col-actions"></th></tr></thead>
      <tbody>\${rows || '<tr><td colspan="6" class="empty-state">No variables yet.</td></tr>'}</tbody>
    </table>
    <button class="btn btn-sm" style="margin-top:10px" onclick="addSchemaRow()">+ Add variable</button>
    <div class="hint">Pick a known type, or choose "Custom…" to enter any value if MI adds a new tag_type.</div>
  \`;
}

function toggleRawMode() {
  if (!rawMode) {
    // Entering raw mode: serialize the current table state so edits aren't lost.
    schemaState.raw = JSON.stringify(Object.assign({}, schemaState.schema, { tags: schemaRows }), null, 2);
  } else {
    // Leaving raw mode: try to parse back into the table; keep raw mode on failure.
    const editorEl = document.getElementById('raw-editor');
    const editorText = editorEl ? editorEl.value : schemaState.raw;

    try {
      const parsed = JSON.parse(editorText);

      if (!parsed || !Array.isArray(parsed.tags)) { throw new Error('Missing "tags" array'); }

      schemaState.schema = parsed;
      schemaRows = parsed.tags.map((t) => Object.assign({}, t));
      schemaState.exists = true;
      delete schemaState.parseError;
    } catch (e) {
      // showBanner() re-renders, which would otherwise regenerate this textarea from the last
      // known-good schemaState.raw — put the user's (still-broken) text back afterward so their
      // in-progress edit isn't silently discarded.
      showBanner('error', 'Cannot switch to table view: ' + escapeHtml(e.message));

      const freshEditorEl = document.getElementById('raw-editor');

      if (freshEditorEl) { freshEditorEl.value = editorText; }

      return;
    }
  }

  rawMode = !rawMode;
  render();
}

function updateSchemaField(i, field, value) {
  schemaRows[i][field] = value;
  setDirty(true);
}

function autosizeCellTextarea(el) {
  if (!el || el.type === 'color' || el.type === 'checkbox') { return; }

  el.style.height = '0';
  el.style.height = Math.max(30, el.scrollHeight) + 'px';
}

function autosizeAllCellTextareas() {
  Array.prototype.forEach.call(
    document.querySelectorAll('.cell-textarea, .ve-list-field textarea, .ve-list-field input[type=text], .ve-list-field select, .ve-values-field textarea, .ve-values-field input[type=text], .ve-values-field select'),
    autosizeCellTextarea
  );
}

function updateSchemaAdditionalOptions(i, text) {
  try {
    schemaRows[i].additional_options = text.trim() ? JSON.parse(text) : '';
    invalidAdditionalOptionsRows.delete(schemaRows[i]);
  } catch {
    schemaRows[i].additional_options = text;
    invalidAdditionalOptionsRows.add(schemaRows[i]);
  }

  setDirty(true);
}

// Normalize list-tag additional_options into editable column objects. Non-array values
// (flat-list "" / invalid raw text) become an empty column list — editing via the UI replaces them.
function listColumnsFor(tag) {
  const opts = tag && tag.additional_options;

  if (!Array.isArray(opts)) { return []; }

  return opts.map((c) => (typeof c === 'string' ? { name: c, type: 'textarea' } : Object.assign({}, c)));
}

function syncAdditionalOptionsRaw(i) {
  const ta = document.getElementById('ao-raw-' + i);

  if (!ta || ta.disabled) { return; }

  const value = schemaRows[i].additional_options;

  ta.value = value !== undefined && value !== '' ? JSON.stringify(value) : '';
}

// Persist select/multi-select columns without a redundant source when options are present —
// source is only kept when there is no options list (non-static / empty options).
function normalizeListColumn(col) {
  const out = Object.assign({ name: '', type: 'textarea' }, col);
  const type = out.type || 'textarea';
  const isSelect = type === 'select' || type === 'multi-select';

  if (!isSelect) {
    delete out.source;
    delete out.options;

    return out;
  }

  if (Array.isArray(out.options) && out.options.length) {
    delete out.source;
  } else {
    delete out.options;

    if (!out.source) {
      out.source = 'static';
    }
  }

  return out;
}

function commitListColumns(i, columns, rerender) {
  const normalized = columns.map(normalizeListColumn);

  schemaRows[i].additional_options = normalized.length ? normalized : '';
  invalidAdditionalOptionsRows.delete(schemaRows[i]);
  setDirty(true);

  if (rerender) {
    rerenderKeepingAdvancedOpen(i);
  } else {
    syncAdditionalOptionsRaw(i);
  }
}

function listColumnSelectOptions(values, selected) {
  return values.map((v) =>
    '<option value="' + escapeHtml(v) + '"' + (v === selected ? ' selected' : '') + '>' + escapeHtml(v) + '</option>'
  ).join('');
}

function listColumnItemHtml(col, i, colIndex) {
  const name = col.name != null ? String(col.name) : '';
  const type = LIST_COLUMN_TYPES.indexOf(col.type) !== -1 ? col.type : (col.type || 'textarea');
  const isSelect = type === 'select' || type === 'multi-select';
  const source = col.source || 'static';
  const optionsText = Array.isArray(col.options) ? col.options.join(', ') : '';

  const typeOptions = listColumnSelectOptions(
    LIST_COLUMN_TYPES.indexOf(type) !== -1 ? LIST_COLUMN_TYPES : LIST_COLUMN_TYPES.concat([type]),
    type
  );

  let bottom =
    '<div class="ve-ao-column-field">' +
      '<label>type</label>' +
      '<select onchange="updateListColumnField(' + i + ',' + colIndex + ',\\'type\\',this.value)">' + typeOptions + '</select>' +
    '</div>';

  if (isSelect) {
    const sourceOptions = listColumnSelectOptions(
      LIST_COLUMN_SOURCES.indexOf(source) !== -1 ? LIST_COLUMN_SOURCES : LIST_COLUMN_SOURCES.concat([source]),
      source
    );

    bottom +=
      '<div class="ve-ao-column-field">' +
        '<label>source</label>' +
        '<select onchange="updateListColumnField(' + i + ',' + colIndex + ',\\'source\\',this.value)">' + sourceOptions + '</select>' +
      '</div>';

    if (source === 'static') {
      bottom +=
        '<div class="ve-ao-column-field">' +
          '<label>options</label>' +
          '<input type="text" value="' + escapeHtml(optionsText) + '" placeholder="Options (comma-separated)" oninput="updateListColumnOptions(' + i + ',' + colIndex + ',this.value)" />' +
        '</div>';
    }
  }

  return '<div class="ve-ao-column" data-row="' + i + '" data-col-index="' + colIndex + '" ondragover="onListColumnDragOver(event)" ondrop="onListColumnDrop(event)" ondragleave="onListColumnDragLeave(event)">' +
    '<span class="ve-ao-column-handle" draggable="true" ondragstart="onListColumnDragStart(event)" ondragend="onListColumnDragEnd(event)" title="Drag to reorder" aria-label="Drag to reorder" role="button" tabindex="0">⠿</span>' +
    '<div class="ve-ao-column-fields">' +
      '<div class="ve-ao-column-top">' +
        '<div class="ve-ao-column-field">' +
          '<label>name</label>' +
          '<div class="ve-ao-column-name">' +
            '<input type="text" value="' + escapeHtml(name) + '" oninput="updateListColumnField(' + i + ',' + colIndex + ',\\'name\\',this.value)" placeholder="Column name" />' +
            '<button type="button" class="btn btn-sm ve-ao-column-remove" onclick="removeListColumn(' + i + ',' + colIndex + ')" title="Remove column">✕</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="ve-ao-column-bottom">' + bottom + '</div>' +
    '</div>' +
  '</div>';
}

function listColumnsEditorHtml(tag, i) {
  const cols = listColumnsFor(tag);
  const itemsHtml = cols.map((col, colIndex) => listColumnItemHtml(col, i, colIndex)).join('');

  return '<div class="box-style" style="grid-column:1/-1">' +
    '<label>additional_options (UI version)<button type="button" class="btn btn-sm" style="text-transform:none;padding:0 6px;margin-left:4px" onclick="showListColumnsHelp()" title="What is additional_options for list?">?</button></label>' +
    
    '<div class="ve-ao-columns">' + itemsHtml + '</div>' +
    '<button type="button" class="btn btn-sm" style="margin-top:8px" onclick="addListColumn(' + i + ')">+ Add column</button>' +
  '</div>';
}

function showListColumnsHelp() {
  showInfoModal(
    'additional_options — list',
    '<p>An array of column definitions — each list item becomes an object keyed by these names. Supported field <code>types</code>: <code>textarea</code>, <code>color</code>, <code>select</code>, <code>multi-select</code>, <code>file</code>.</p>' +
    '<p>Edited below as a column editor — reordering/adding/removing there is the same thing as hand-editing this JSON array, just without needing to write JSON.</p>'
  );
}

function addListColumn(i) {
  const cols = listColumnsFor(schemaRows[i]);

  cols.push({ name: '', type: 'textarea' });
  commitListColumns(i, cols, true);
}

function removeListColumn(i, colIndex) {
  const cols = listColumnsFor(schemaRows[i]);

  cols.splice(colIndex, 1);
  commitListColumns(i, cols, true);
}

var listColumnDrag = null;

function onListColumnDragStart(ev) {
  const col = ev.target.closest('.ve-ao-column');

  if (!col) { return; }

  listColumnDrag = {
    row: Number(col.dataset.row),
    fromIndex: Number(col.dataset.colIndex),
  };
  col.classList.add('is-dragging');
  ev.dataTransfer.effectAllowed = 'move';
  // Firefox requires setData for the drag to start.
  ev.dataTransfer.setData('text/plain', String(listColumnDrag.fromIndex));
}

function onListColumnDragOver(ev) {
  // Schema-row reordering can pass over list-column cards inside an open advanced panel —
  // accept the drag here so the drop isn't blocked by nested handlers.
  if (schemaRowDrag) {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';

    const details = ev.currentTarget.closest('tr.details-row');

    if (details) { details.classList.add('is-drop-target'); }

    return;
  }

  if (!listColumnDrag) { return; }

  const col = ev.currentTarget;

  if (Number(col.dataset.row) !== listColumnDrag.row) { return; }

  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  col.classList.add('is-drop-target');
}

function onListColumnDragLeave(ev) {
  const col = ev.currentTarget;

  // Ignore leave events that stay inside the same column card (child elements).
  if (col.contains(ev.relatedTarget)) { return; }

  col.classList.remove('is-drop-target');

  if (schemaRowDrag) {
    const details = col.closest('tr.details-row');

    if (details && !details.contains(ev.relatedTarget)) {
      details.classList.remove('is-drop-target');
    }
  }
}

function onListColumnDrop(ev) {
  ev.preventDefault();

  const col = ev.currentTarget;

  col.classList.remove('is-drop-target');

  if (schemaRowDrag) {
    const details = col.closest('tr.details-row');

    if (!details) { return; }

    details.classList.remove('is-drop-target');

    const toIndex = Number(details.dataset.rowIndex);
    const fromIndex = schemaRowDrag.fromIndex;

    schemaRowDrag = null;

    if (fromIndex !== toIndex) {
      reorderSchemaRow(fromIndex, toIndex);
    }

    return;
  }

  if (!listColumnDrag || Number(col.dataset.row) !== listColumnDrag.row) { return; }

  const toIndex = Number(col.dataset.colIndex);
  const fromIndex = listColumnDrag.fromIndex;

  listColumnDrag = null;

  if (fromIndex === toIndex) { return; }

  reorderListColumn(Number(col.dataset.row), fromIndex, toIndex);
}

function onListColumnDragEnd() {
  listColumnDrag = null;
  Array.prototype.forEach.call(document.querySelectorAll('.ve-ao-column.is-dragging, .ve-ao-column.is-drop-target'), function (el) {
    el.classList.remove('is-dragging', 'is-drop-target');
  });
}

function reorderListColumn(i, fromIndex, toIndex) {
  const cols = listColumnsFor(schemaRows[i]);

  if (fromIndex < 0 || fromIndex >= cols.length || toIndex < 0 || toIndex >= cols.length) { return; }

  const moved = cols.splice(fromIndex, 1)[0];

  cols.splice(toIndex, 0, moved);
  commitListColumns(i, cols, true);
}

function updateListColumnField(i, colIndex, field, value) {
  const cols = listColumnsFor(schemaRows[i]);
  const col = Object.assign({ name: '', type: 'textarea' }, cols[colIndex]);

  if (field === 'name') {
    col.name = value;
  } else if (field === 'type') {
    col.type = value;

    if (value !== 'select' && value !== 'multi-select') {
      delete col.source;
      delete col.options;
    } else if (Array.isArray(col.options) && col.options.length) {
      delete col.source;
    } else if (!col.source) {
      col.source = 'static';
    }
  } else if (field === 'source') {
    col.source = value;

    if (value !== 'static') {
      delete col.options;
    }
  }

  cols[colIndex] = col;
  commitListColumns(i, cols, field === 'type' || field === 'source');
}

function updateListColumnOptions(i, colIndex, text) {
  const cols = listColumnsFor(schemaRows[i]);
  const col = Object.assign({ name: '', type: 'textarea' }, cols[colIndex]);
  const options = text.split(',').map((s) => s.trim()).filter(Boolean);

  if (options.length) {
    col.options = options;
    delete col.source;
  } else {
    delete col.options;

    if (!col.source) {
      col.source = 'static';
    }
  }

  cols[colIndex] = col;
  commitListColumns(i, cols, false);
}

function toggleSchemaAdvanced(i) {
  const row = document.getElementById('advanced-' + i);
  const btn = document.getElementById('expand-btn-' + i);
  const nowOpen = row.style.display === 'none';

  row.style.display = nowOpen ? '' : 'none';

  if (btn) {
    btn.textContent = nowOpen ? '▾' : '▸';
    btn.setAttribute('aria-expanded', String(nowOpen));
  }
}

// Fallback only (network hiccup) — the server generates a real MD5 via /@api/variables/new-uid,
// since Node's crypto has real MD5 and the browser doesn't. This is just same-shaped filler.
function fallbackUid() {
  var s = '';

  while (s.length < 32) {
    s += Math.random().toString(16).slice(2);
  }

  return s.slice(0, 32);
}

async function addSchemaRow() {
  var uid = fallbackUid();

  try {
    var r = await fetch('/@api/variables/new-uid');
    var data = await r.json();

    if (data && typeof data.uid === 'string') {
      uid = data.uid;
    }
  } catch (e) {
    // keep the fallback uid
  }

  schemaState.exists = true;
  schemaRows.push({
    name: 'new_variable_' + (schemaRows.length + 1),
    uid: uid,
    tag_type: 'text',
    tag_source: 'static',
    default_value: '',
    additional_options: '',
    description: '',
  });
  setDirty(true);
  render();
}

function removeSchemaRow(i) {
  const name = (schemaRows[i] && schemaRows[i].name) || '(unnamed)';

  showConfirmModal('Delete variable "' + name + '"? This only takes effect once you Save.', () => {
    schemaRows.splice(i, 1);
    setDirty(true);
    render();
  });
}

function schemaRowOpenKey(tag, i) {
  return tag && tag.uid ? String(tag.uid) : (tag && tag.name ? 'name:' + tag.name : 'idx:' + i);
}

function collectOpenAdvancedKeys() {
  const open = [];

  schemaRows.forEach((tag, i) => {
    const el = document.getElementById('advanced-' + i);

    if (el && el.style.display !== 'none') {
      open.push(schemaRowOpenKey(tag, i));
    }
  });

  return open;
}

function restoreOpenAdvancedKeys(openKeys) {
  if (!openKeys || !openKeys.length) { return; }

  schemaRows.forEach((tag, i) => {
    if (openKeys.indexOf(schemaRowOpenKey(tag, i)) === -1) { return; }

    const after = document.getElementById('advanced-' + i);
    const btn = document.getElementById('expand-btn-' + i);

    if (after) { after.style.display = ''; }
    if (btn) {
      btn.textContent = '▾';
      btn.setAttribute('aria-expanded', 'true');
    }
  });
}

var schemaRowDrag = null;

function onSchemaRowDragStart(ev) {
  const row = ev.target.closest('tr.schema-row');

  if (!row) { return; }

  const fromIndex = Number(row.dataset.rowIndex);

  schemaRowDrag = { fromIndex: fromIndex };
  row.classList.add('is-dragging');

  const details = document.getElementById('advanced-' + fromIndex);

  if (details) { details.classList.add('is-dragging'); }

  ev.dataTransfer.effectAllowed = 'move';
  // Firefox requires setData for the drag to start.
  ev.dataTransfer.setData('text/plain', String(fromIndex));
}

function onSchemaRowDragOver(ev) {
  if (!schemaRowDrag) { return; }

  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  ev.currentTarget.classList.add('is-drop-target');
}

function onSchemaRowDragLeave(ev) {
  const row = ev.currentTarget;

  if (row.contains(ev.relatedTarget)) { return; }

  row.classList.remove('is-drop-target');
}

function onSchemaRowDrop(ev) {
  ev.preventDefault();

  const row = ev.currentTarget;

  row.classList.remove('is-drop-target');

  if (!schemaRowDrag) { return; }

  const toIndex = Number(row.dataset.rowIndex);
  const fromIndex = schemaRowDrag.fromIndex;

  schemaRowDrag = null;

  if (fromIndex === toIndex) { return; }

  reorderSchemaRow(fromIndex, toIndex);
}

function onSchemaRowDragEnd() {
  schemaRowDrag = null;
  Array.prototype.forEach.call(document.querySelectorAll('tr.schema-row.is-dragging, tr.schema-row.is-drop-target, tr.details-row.is-dragging, tr.details-row.is-drop-target'), function (el) {
    el.classList.remove('is-dragging', 'is-drop-target');
  });
}

function reorderSchemaRow(fromIndex, toIndex) {
  if (fromIndex < 0 || fromIndex >= schemaRows.length || toIndex < 0 || toIndex >= schemaRows.length) { return; }

  const openKeys = collectOpenAdvancedKeys();
  const moved = schemaRows.splice(fromIndex, 1)[0];

  schemaRows.splice(toIndex, 0, moved);
  setDirty(true);
  render();
  restoreOpenAdvancedKeys(openKeys);
}

async function saveSchema() {
  let raw;
  const beforeText = jsonBaseline.schema;

  if (rawMode) {
    raw = document.getElementById('raw-editor').value;
  } else {
    const invalidAdditionalOptionsIndex = schemaRows.findIndex((row) => invalidAdditionalOptionsRows.has(row));

    if (invalidAdditionalOptionsIndex !== -1) {
      const tagName = schemaRows[invalidAdditionalOptionsIndex].name || ('row ' + (invalidAdditionalOptionsIndex + 1));

      showBanner('error', 'additional_options must be valid JSON for "' + escapeHtml(tagName) + '".');

      return;
    }

    raw = JSON.stringify(Object.assign({}, schemaState.schema, { tags: schemaRows }), null, 2);
  }

  if (normalizeJsonText(beforeText) === normalizeJsonText(raw)) {
    setDirty(false);
    showBanner('success', 'No JSON changes to save.');

    return;
  }

  showJsonDiffModal(beforeText, raw, () => commitSchemaSave(raw));
}

async function commitSchemaSave(raw) {
  const saveEditSeq = editSeq;
  const r = await fetch('/@api/variables/schema', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const data = await r.json();

  if (!r.ok) {
    showBanner('error', escapeHtml(data.error || 'Save failed.'));

    return;
  }

  const warnings = data.warnings || [];
  const hasNewerEdits = editSeq !== saveEditSeq;
  const message = warnings.length
    ? 'Saved, with warning(s):<ul>' + warnings.map((w) => '<li>' + escapeHtml(w) + '</li>').join('') + '</ul>'
    : 'Schema saved.';

  if (hasNewerEdits) {
    showBanner('warning', message + '<div>Newer edits remain unsaved.</div>', true);

    return;
  }

  setDirty(false);
  showBanner(warnings.length ? 'warning' : 'success', message);
  jsonBaseline.schema = raw;

  await loadTabData('schema');
  render();
}

// ── Values tab ───────────────────────────────────────────────────────────────
function schemaTagFor(name) {
  const tags = (valuesState.schema && valuesState.schema.tags) || [];

  return tags.find((t) => t.name === name);
}

// Not full markdown (MI itself renders this as markdown) — a lightweight, dependency-free
// line-break-preserving plain-text display is enough context to have here.
function descriptionHint(tag) {
  if (!tag || !tag.description) { return ''; }

  return '<div class="hint" style="white-space:pre-wrap;margin-bottom: 8px;">' + escapeHtml(tag.description) + '</div>';
}

// The plain-text default already matches MI's own fallback (a multiline input); on top of
// that, mirror the three editor-flag checkboxes from the Schema tab's Advanced panel — MI's
// own value editor swaps in a rich/code editor for the first two (we use a plain textarea for
// both, since embedding a real WYSIWYG editor is out of scope for this lightweight tool). The
// third (use_json_editor_ind) is accepted by MI's create form but never actually acted upon by
// its value editor either — shown here only as an FYI, no widget change.
function textValueCell(tag, row, i) {
  const widget = '<textarea class="cell-textarea" oninput="autosizeCellTextarea(this);updateValueField(' + i + ', this.value)">' + escapeHtml(row.value) + '</textarea>';
  let note = '';

  if (tag.use_hmtl_editor_ind === 'Y') {
    note = 'WYSIWYG HTML in MI — edited as raw HTML here.';
  } else if (tag.use_raw_html_ind === 'Y') {
    note = 'Raw HTML — MI skips XSS-encoding this value on save.';
  } else if (tag.use_json_editor_ind === 'Y') {
    note = 'JSON Editor flag is set, though MI\\'s value editor doesn\\'t actually act on it.';
  }

  return note ? widget + '<div class="hint">' + note + '</div>' : widget;
}

function normalizeStaticOptions(tag) {
  const opts = tag && tag.additional_options;

  if (!Array.isArray(opts)) { return []; }

  return opts.map((o) => (typeof o === 'string' ? { id: o, text: o } : { id: String(o.id), text: String(o.text != null ? o.text : o.id) }));
}

function labelForOption(options, id) {
  const found = options.find((o) => o.id === id);

  return found ? found.text : id;
}

function comboOptionsHtml(options) {
  return options.map((o) =>
    '<div class="ve-combo-option" data-id="' + escapeHtml(o.id) + '" data-text="' + escapeHtml(o.text) + '" onmousedown="event.preventDefault();onComboOptionPick(this)">' +
    (o.text !== o.id ? escapeHtml(o.text) + ' <span class="hint">(' + escapeHtml(o.id) + ')</span>' : escapeHtml(o.id)) +
    '</div>',
  ).join('');
}

function chipHtml(id, text) {
  return '<span class="ve-chip" data-id="' + escapeHtml(id) + '">' + escapeHtml(text) + '<button type="button" onmousedown="event.preventDefault()" onclick="onChipRemove(this)">✕</button></span>';
}

// A search-as-you-type combobox — not a native <select>/<datalist> (see the Schema tab's
// tag_type picker for why: unstylable popups, broken selected-state colors). Only viable for
// tag_source "static", since that's the only source whose options live in additional_options
// itself; every other source needs MI's own internal editor-only options endpoint, which we
// deliberately don't call (no public API for it — see TEMPLATE_VARIABLES.md).
function selectValueWidget(tag, row, i) {
  const options = normalizeStaticOptions(tag);
  const isMulti = tag.tag_type === 'multiselect';

  if (isMulti) {
    const ids = row.value ? row.value.split(',').filter(Boolean) : [];
    const chips = ids.map((id) => chipHtml(id, labelForOption(options, id))).join('');

    return '<div class="ve-combo ve-combo-multi">' +
      '<div class="ve-combo-chips" data-row="' + i + '" id="combo-chips-' + i + '">' + chips + '</div>' +
      '<input type="text" class="ve-combo-input" placeholder="Search by id or value…" oninput="onComboFilter(' + i + ',this.value)" onfocus="onComboFocus(' + i + ')" onblur="onComboBlur(' + i + ')" />' +
      '<div class="ve-combo-list" id="combo-list-' + i + '" style="display:none">' + comboOptionsHtml(options) + '</div>' +
      '</div>';
  }

  return '<div class="ve-combo">' +
    '<input type="text" class="ve-combo-input" value="' + escapeHtml(row.value || '') + '" placeholder="Search by id or value…" oninput="onSingleComboInput(' + i + ',this.value)" onfocus="onComboFocus(' + i + ')" onblur="onComboBlur(' + i + ')" />' +
    '<div class="ve-combo-list" id="combo-list-' + i + '" style="display:none">' + comboOptionsHtml(options) + '</div>' +
    '</div>';
}

function onComboFocus(i) {
  const list = document.getElementById('combo-list-' + i);

  if (list) { list.style.display = ''; }
}

function onComboBlur(i) {
  // mousedown+preventDefault() on options already stops most blurs from firing before a pick
  // registers; this is just a safety net for focus leaving for any other reason (e.g. Tab).
  setTimeout(() => {
    const list = document.getElementById('combo-list-' + i);

    if (list) { list.style.display = 'none'; }
  }, 150);
}

function onComboFilter(i, text) {
  const list = document.getElementById('combo-list-' + i);

  if (!list) { return; }

  const needle = text.toLowerCase();

  Array.from(list.children).forEach((opt) => {
    const hay = (opt.dataset.id + ' ' + opt.dataset.text).toLowerCase();

    opt.style.display = hay.indexOf(needle) === -1 ? 'none' : '';
  });
}

function onSingleComboInput(i, text) {
  onComboFilter(i, text);
  updateValueField(i, text);
}

function onComboOptionPick(optEl) {
  const list = optEl.closest('.ve-combo-list');
  const i = Number(list.id.replace('combo-list-', ''));
  const id = optEl.dataset.id;
  const text = optEl.dataset.text || id;
  const combo = optEl.closest('.ve-combo');
  const chipsEl = combo.querySelector('.ve-combo-chips');

  if (chipsEl) {
    const already = Array.from(chipsEl.children).some((c) => c.dataset.id === id);

    if (!already) {
      chipsEl.insertAdjacentHTML('beforeend', chipHtml(id, text));
    }

    const inputEl = combo.querySelector('.ve-combo-input');

    inputEl.value = '';
    onComboFilter(i, '');
    commitMultiValue(i, chipsEl);
  } else {
    const inputEl = combo.querySelector('.ve-combo-input');

    inputEl.value = id;
    updateValueField(i, id);
    list.style.display = 'none';
  }
}

function onChipRemove(btn) {
  const chip = btn.closest('.ve-chip');
  const chipsEl = chip.parentElement;
  const i = Number(chipsEl.dataset.row);

  chip.remove();
  commitMultiValue(i, chipsEl);
}

function commitMultiValue(i, chipsEl) {
  const ids = Array.from(chipsEl.children).map((c) => c.dataset.id);

  updateValueField(i, ids.join(','));
}

// Non-empty additional_options (array) means column-defined objects; empty/absent means a flat
// list of strings. A bare string entry is shorthand for { name: <string>, type: 'textarea' }.
function listConfigFor(tag) {
  const opts = tag && tag.additional_options;

  return Array.isArray(opts) && opts.length
    ? opts.map((c) => (typeof c === 'string' ? { name: c, type: 'textarea' } : c))
    : null;
}

function parseListItems(row) {
  try {
    const parsed = row.value ? JSON.parse(row.value) : [];

    // A stored "null" (MI's own encoding for "no value yet") means an empty list, not invalid
    // JSON — only reject genuinely non-array, non-null JSON (e.g. an object or a number).
    if (parsed === null) { return []; }

    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function sourceBadgeHtml(source) {
  if (!source) { return ''; }

  const kind = String(source).toLowerCase();
  const extra = kind === 'dataset' ? ' badge-source-dataset' : kind === 'static' ? ' badge-source-static' : '';

  return '<span class="badge' + extra + '">' + escapeHtml(source) + '</span>';
}

function typeBadgeHtml(type) {
  if (!type) { return ''; }

  return '<span class="badge">' + escapeHtml(type) + '</span>';
}

function listItemLabel(config, item, itemIndex) {
  if (!config) {
    const val = typeof item === 'string' ? item : String(item != null ? item : '');

    return val || ('Item ' + (itemIndex + 1));
  }

  const parts = [];

  config.forEach((col) => {
    const colName = typeof col === 'string' ? col : col.name;
    const raw = item && typeof item === 'object' ? item[colName] : '';

    if (raw != null && String(raw).trim()) {
      parts.push(String(raw).trim());
    }
  });

  return parts.slice(0, 2).join(' · ') || ('Item ' + (itemIndex + 1));
}

function listFieldLabelHtml(colName, source) {
  return '<div class="ve-values-field-label"><span>' + escapeHtml(colName) + '</span>' + sourceBadgeHtml(source) + '</div>';
}

function listValueWidget(tag, row, i) {
  const items = parseListItems(row);

  if (items === null) {
    return '<div class="ve-values-field is-wide"><div class="ve-values-field-label"><span>value</span></div>' +
      '<textarea class="cell-textarea" oninput="autosizeCellTextarea(this);updateValueField(' + i + ', this.value)">' + escapeHtml(row.value) + '</textarea>' +
      '<div class="hint" style="color:var(--red)">Not a valid JSON array — edit as raw text above, or fix it via "View/edit raw JSON".</div></div>';
  }

  const config = listConfigFor(tag);
  const itemsHtml = items.map((item, itemIndex) => {
    return '<div class="ve-values-list-item" data-value-index="' + i + '" data-item-index="' + itemIndex + '"' +
      ' ondragover="onListItemDragOver(event)" ondrop="onListItemDrop(event)" ondragleave="onListItemDragLeave(event)">' +
      '<span class="ve-values-list-item-handle" draggable="true" ondragstart="onListItemDragStart(event)" ondragend="onListItemDragEnd(event)" title="Drag to reorder" aria-label="Drag to reorder" role="button" tabindex="0">⠿</span>' +
      listItemFieldsHtml(config, item, i, itemIndex) +
    '</div>';
  }).join('');

  return '<div class="ve-values-list-items">' +
    (itemsHtml || '<div class="ve-values-empty">No items yet.</div>') +
  '</div>' +
    '<button type="button" class="ve-values-nav-item ve-values-nav-add" style="margin-top:12px;width:auto" onclick="addListItem(' + i + ')">+ Add item</button>';
}

function listItemFieldsHtml(config, item, i, itemIndex) {
  if (!config) {
    const val = typeof item === 'string' ? item : String(item != null ? item : '');

    return '<div class="ve-values-fields"><div class="ve-values-field is-wide">' +
      '<textarea class="cell-textarea" oninput="autosizeCellTextarea(this);updateListItemField(' + i + ',' + itemIndex + ',null,this.value)">' + escapeHtml(val) + '</textarea>' +
    '</div></div>';
  }

  const fieldsHtml = config.map((col) => {
    const colName = typeof col === 'string' ? col : col.name;
    const colNameJs = escapeJsAttr(colName);
    const colType = typeof col === 'string' ? 'textarea' : (col.type || 'textarea');
    const colSource = typeof col === 'object' && col.source ? col.source : (colType === 'select' || colType === 'multi-select' ? 'static' : '');
    const rawVal = typeof item === 'object' && item !== null ? item[colName] : '';
    const val = rawVal != null ? String(rawVal) : '';
    const wide = colType === 'textarea' || colType === 'file' || val.length > 48 ? ' is-wide' : '';

    if (colType === 'color') {
      const safe = /^#[0-9a-fA-F]{3,8}$/.test(val) ? val : '#000000';

      return '<div class="ve-values-field">' + listFieldLabelHtml(colName, colSource) +
        '<input type="color" value="' + safe + '" oninput="updateListItemField(' + i + ',' + itemIndex + ',\\'' + colNameJs + '\\',this.value)" /></div>';
    }

    if (colType === 'select' || colType === 'multi-select') {
      const isMulti = colType === 'multi-select';

      // Only "static" ships its option list locally (col.options); every other source is
      // populated live by MI's own editor (see additionalOptionsDetails()) and pp-dev has no
      // API to fetch it here — fall back to free text, same as the tag-level select does.
      if (colSource !== 'static') {
        return '<div class="ve-values-field">' + listFieldLabelHtml(colName, colSource) +
          '<input type="text" value="' + escapeHtml(val) + '" oninput="updateListItemField(' + i + ',' + itemIndex + ',\\'' + colNameJs + '\\',this.value)" placeholder="source: ' + escapeHtml(colSource) + ' — no local option list" /></div>';
      }

      const opts = typeof col === 'object' && Array.isArray(col.options) ? col.options : [];
      const selected = isMulti ? val.split(',').filter(Boolean) : [val];
      const optionsHtml = opts.map((o) => '<option value="' + escapeHtml(o) + '"' + (selected.indexOf(o) !== -1 ? ' selected' : '') + '>' + escapeHtml(o) + '</option>').join('');

      return '<div class="ve-values-field">' + listFieldLabelHtml(colName, colSource) +
        '<select ' + (isMulti ? 'multiple ' : '') + 'onchange="autosizeCellTextarea(this);onListItemSelectChange(' + i + ',' + itemIndex + ',\\'' + colNameJs + '\\',this,' + isMulti + ')">' + optionsHtml + '</select></div>';
    }

    return '<div class="ve-values-field' + wide + '">' + listFieldLabelHtml(colName, colSource) +
      '<textarea class="cell-textarea" oninput="autosizeCellTextarea(this);updateListItemField(' + i + ',' + itemIndex + ',\\'' + colNameJs + '\\',this.value)">' + escapeHtml(val) + '</textarea></div>';
  }).join('');

  return '<div class="ve-values-fields">' + fieldsHtml + '</div>';
}

function onListItemSelectChange(i, itemIndex, fieldName, selectEl, isMulti) {
  const value = isMulti
    ? Array.from(selectEl.selectedOptions).map((o) => o.value).join(',')
    : selectEl.value;

  updateListItemField(i, itemIndex, fieldName, value);
}

function updateListItemField(i, itemIndex, fieldName, value) {
  const items = parseListItems(valueRows[i]) || [];

  if (fieldName === null) {
    items[itemIndex] = value;
  } else {
    if (typeof items[itemIndex] !== 'object' || items[itemIndex] === null || Array.isArray(items[itemIndex])) {
      items[itemIndex] = {};
    }

    items[itemIndex][fieldName] = value;
  }

  valueRows[i].value = JSON.stringify(items);
  setDirty(true);
}

function addListItem(i) {
  const items = parseListItems(valueRows[i]) || [];
  const config = listConfigFor(schemaTagFor(valueRows[i].name));

  if (config) {
    const newItem = {};

    config.forEach((col) => { newItem[typeof col === 'string' ? col : col.name] = ''; });
    items.push(newItem);
  } else {
    items.push('');
  }

  valueRows[i].value = JSON.stringify(items);
  selectedValueIndex = i;
  selectedListItemIndex = items.length - 1;
  setDirty(true);
  render();
}

function removeListItem(i, itemIndex) {
  const items = parseListItems(valueRows[i]) || [];

  items.splice(itemIndex, 1);
  valueRows[i].value = JSON.stringify(items);
  selectedValueIndex = i;
  selectedListItemIndex = Math.min(itemIndex, Math.max(0, items.length - 1));
  setDirty(true);
  render();
}

var listItemDrag = null;

function onListItemDragStart(ev) {
  const item = ev.target.closest('.ve-values-list-item');

  if (!item) { return; }

  listItemDrag = {
    valueIndex: Number(item.dataset.valueIndex),
    fromIndex: Number(item.dataset.itemIndex),
  };
  item.classList.add('is-dragging');
  ev.dataTransfer.effectAllowed = 'move';
  // Firefox requires setData for the drag to start.
  ev.dataTransfer.setData('text/plain', String(listItemDrag.fromIndex));
}

function onListItemDragOver(ev) {
  if (!listItemDrag) { return; }

  const item = ev.currentTarget;

  if (Number(item.dataset.valueIndex) !== listItemDrag.valueIndex) { return; }

  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  item.classList.add('is-drop-target');
}

function onListItemDragLeave(ev) {
  const item = ev.currentTarget;

  // Ignore leave events that stay inside the same item card (child elements).
  if (item.contains(ev.relatedTarget)) { return; }

  item.classList.remove('is-drop-target');
}

function onListItemDrop(ev) {
  ev.preventDefault();

  const item = ev.currentTarget;

  item.classList.remove('is-drop-target');

  if (!listItemDrag || Number(item.dataset.valueIndex) !== listItemDrag.valueIndex) { return; }

  const toIndex = Number(item.dataset.itemIndex);
  const fromIndex = listItemDrag.fromIndex;

  listItemDrag = null;

  if (fromIndex === toIndex) { return; }

  reorderListItem(Number(item.dataset.valueIndex), fromIndex, toIndex);
}

function onListItemDragEnd() {
  listItemDrag = null;
  Array.prototype.forEach.call(document.querySelectorAll('.ve-values-list-item.is-dragging, .ve-values-list-item.is-drop-target'), function (el) {
    el.classList.remove('is-dragging', 'is-drop-target');
  });
}

function reorderListItem(i, fromIndex, toIndex) {
  const items = parseListItems(valueRows[i]) || [];

  if (fromIndex < 0 || fromIndex >= items.length || toIndex < 0 || toIndex >= items.length) { return; }

  const moved = items.splice(fromIndex, 1)[0];

  items.splice(toIndex, 0, moved);
  valueRows[i].value = JSON.stringify(items);
  selectedValueIndex = i;
  selectedListItemIndex = toIndex;
  setDirty(true);
  render();
}

function valueEditorCell(row, i) {
  const tag = schemaTagFor(row.name);
  const type = tag ? tag.tag_type : null;

  if (type === 'boolean') {
    // MI's own page-variable UI writes literal 'true'/'false' strings, not 'Y'/'N' — the
    // extra accepted values below are just legacy/lenient reads, not something we write.
    const checked = ['true','Y','1'].includes(row.value);

    return '<input type="checkbox" ' + (checked ? 'checked' : '') + ' onchange="updateValueField(' + i + ', this.checked ? \\'true\\' : \\'false\\')" />';
  }

  if (type === 'color') {
    const safe = /^#[0-9a-fA-F]{3,8}$/.test(row.value) ? row.value : '#000000';

    return '<input type="color" value="' + safe + '" oninput="updateValueField(' + i + ', this.value)" />';
  }

  if ((type === 'select' || type === 'multiselect') && tag) {
    const source = tag.tag_source || 'static';

    if (source === 'static') {
      return selectValueWidget(tag, row, i);
    }

    return '<input type="text" value="' + escapeHtml(row.value) + '" oninput="updateValueField(' + i + ', this.value)" placeholder="tag_source: ' + escapeHtml(source) + ' — no local option list" />';
  }

  if (type === 'file') {
    // No public MI API exists for listing/uploading a page's individual file assets (only
    // whole-bundle zip download/upload, which doesn't fit a single value) — manual path only.
    // MI's own upload control restricts these to images: jpg/jpeg/png/gif/svg.
    return '<input type="text" value="' + escapeHtml(row.value) + '" oninput="updateValueField(' + i + ', this.value)" placeholder="Existing image filename (jpg/jpeg/png/gif/svg)" />';
  }

  if (type === 'list') {
    return listValueWidget(tag, row, i);
  }

  if (type === 'text' && tag) {
    return textValueCell(tag, row, i);
  }

  return '<input type="text" value="' + escapeHtml(row.value) + '" oninput="updateValueField(' + i + ', this.value)" />';
}

// Same convention as the old "Export variables…"/"Setup variables…" flow (now retired in
// favor of this JSON mode): a list-type value is shown/accepted as a native JSON array
// instead of a JSON-string-in-a-string, converting only at this display/parse boundary —
// the PUT /@api/variables/values endpoint itself always sees plain strings.
function toExportableValueRows(rows) {
  return rows.map((row) => {
    const tag = schemaTagFor(row.name);

    if (tag && tag.tag_type === 'list') {
      try {
        const parsed = JSON.parse(row.value);

        if (Array.isArray(parsed)) {
          return { name: row.name, value: parsed };
        }
      } catch (e) {
        // not valid JSON — keep the raw string below
      }
    }

    return { name: row.name, value: row.value };
  });
}

function fromExportableValueRows(entries) {
  return entries.map(({ name, value }) => ({
    name,
    value: typeof value === 'string' ? value : JSON.stringify(value),
  }));
}

// Cheap, best-effort lint pass over the JSON textarea's current text — no textarea-internal
// highlighting (native hover tooltips can't reach through an editable textarea sitting on top
// of an overlay), just a small badge per flagged entry with a native title attribute explanation.
function computeJsonIssues(text) {
  let entries;

  try {
    entries = JSON.parse(text);
  } catch (e) {
    return [];
  }

  if (!Array.isArray(entries)) { return []; }

  const baseline = new Map(
    toExportableValueRows(valuesState && valuesState.combined ? valuesState.combined : [])
      .map((e) => [e.name, JSON.stringify(e.value)]),
  );

  const issues = [];

  entries.forEach((entry) => {
    if (!entry || typeof entry.name !== 'string') { return; }

    const messages = [];
    const tag = schemaTagFor(entry.name);

    if (!tag) {
      messages.push('Not found in the current schema (__template_variables.json) — MI has no matching variable.');
    }

    if (tag && (tag.tag_type === 'select' || tag.tag_type === 'multiselect') && (tag.tag_source || 'static') === 'static') {
      const options = normalizeStaticOptions(tag);

      if (options.length && typeof entry.value === 'string') {
        const tokens = tag.tag_type === 'multiselect'
          ? entry.value.split(',').map((v) => v.trim()).filter(Boolean)
          : [entry.value].filter(Boolean);
        const unmatched = tokens.filter((t) => !options.some((o) => o.id === t || o.text === t));

        if (unmatched.length) {
          messages.push('Value "' + unmatched.join(', ') + '" doesn\\'t match any option in this variable\\'s static list.');
        }
      }
    }

    const canonicalValue = JSON.stringify(entry.value);

    if (baseline.has(entry.name)) {
      if (baseline.get(entry.name) !== canonicalValue) {
        messages.push('Changed since this tab was last loaded/refreshed.');
      }
    } else if (tag) {
      messages.push('New — this variable had no value when this tab was last loaded/refreshed.');
    }

    if (messages.length) {
      issues.push({ name: entry.name, message: messages.join(' ') });
    }
  });

  return issues;
}

function renderJsonIssuesBar(issues) {
  if (!issues.length) { return ''; }

  return '<div class="ve-json-issues">' + issues.map((issue) =>
    '<span class="ve-json-issue-badge" title="' + escapeHtml(issue.message) + '">⚠ ' + escapeHtml(issue.name) + '</span>',
  ).join('') + '</div>';
}

function refreshValuesJsonIssues() {
  const editorEl = document.getElementById('values-raw-editor');
  const issuesEl = document.getElementById('values-raw-issues');

  if (!editorEl || !issuesEl) { return; }

  issuesEl.innerHTML = renderJsonIssuesBar(computeJsonIssues(editorEl.value));
}

let valuesRawIssuesTimer = null;

function onValuesRawInput() {
  setDirty(true);

  if (valuesRawIssuesTimer) { clearTimeout(valuesRawIssuesTimer); }

  valuesRawIssuesTimer = setTimeout(refreshValuesJsonIssues, 300);
}

function downloadValuesJson() {
  const editorEl = document.getElementById('values-raw-editor');
  const text = editorEl ? editorEl.value : JSON.stringify(toExportableValueRows(valueRows), null, 2);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');

  a.href = url;
  a.download = 'page-variables.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function triggerImportValuesJson() {
  document.getElementById('import-values-file').click();
}

function onImportValuesFile(inputEl) {
  const file = inputEl.files[0];

  if (!file) { return; }

  const reader = new FileReader();

  reader.onload = () => {
    const editorEl = document.getElementById('values-raw-editor');

    if (editorEl) {
      editorEl.value = String(reader.result || '');
      setDirty(true);
      refreshValuesJsonIssues();
    }
  };

  reader.readAsText(file);
  inputEl.value = '';
}

function valuesNavItemHtml(row, i, isActive) {
  const tag = schemaTagFor(row.name);
  const type = tag ? (tag.tag_type || 'text') : 'unknown';
  const showsSource = tag && (tag.tag_type === 'select' || tag.tag_type === 'multiselect' || tag.tag_type === 'list');
  const source = showsSource ? (tag.tag_source || 'static') : '';

  return '<button type="button" class="ve-values-nav-item' + (isActive ? ' is-active' : '') + '" data-value-index="' + i + '" onclick="selectValueRow(' + i + ')">' +
    '<span class="ve-values-nav-dot"></span>' +
    '<span class="ve-values-nav-label">' + escapeHtml(row.name || '(unnamed)') + '</span>' +
    '<span class="ve-values-nav-badges">' + typeBadgeHtml(type) + sourceBadgeHtml(source) + '</span>' +
  '</button>';
}

function valuesDetailHtml(row, i) {
  const tag = schemaTagFor(row.name);
  const type = tag ? (tag.tag_type || 'text') : '';
  const source = tag && tag.tag_source ? tag.tag_source : '';
  const isList = type === 'list';

  const header = '<div class="ve-values-detail-header">' +
    '<div class="ve-values-detail-title">' + escapeHtml(row.name || '(unnamed)') + '</div>' +
    listFieldLabelHtml(type || 'value', source) +
    '<button type="button" class="btn btn-sm" onclick="removeValueRow(' + i + ')" title="Delete variable">✕</button>' +
  '</div>';

  if (isList) {
    return header + descriptionHint(tag) + listValueWidget(tag, row, i);
  }

  return header + descriptionHint(tag) +
    '<div class="ve-values-fields"><div class="ve-values-field is-wide">' +
      valueEditorCell(row, i) +
    '</div></div>';
}

function updateValueNavActive(i) {
  Array.prototype.forEach.call(document.querySelectorAll('.ve-values-nav-list .ve-values-nav-item[data-value-index]'), function (el) {
    const active = Number(el.dataset.valueIndex) === i;

    el.classList.toggle('is-active', active);

    if (active) {
      el.scrollIntoView({ block: 'nearest' });
    }
  });
  Array.prototype.forEach.call(document.querySelectorAll('.ve-values-anchor[data-value-index]'), function (el) {
    el.classList.toggle('is-active', Number(el.dataset.valueIndex) === i);
  });
}

function scrollToValueRow(i, smooth) {
  const detail = document.querySelector('.ve-values-detail');
  const target = document.getElementById('value-item-' + i);

  if (!detail || !target || typeof detail.scrollTo !== 'function') { return; }

  const top = target.getBoundingClientRect().top - detail.getBoundingClientRect().top + detail.scrollTop;

  detail.scrollTo({ top: Math.max(0, top - 8), behavior: smooth ? 'smooth' : 'auto' });
}

var valueNavScrollLock = false;
var valueNavScrollLockTimer = null;

function selectValueRow(i) {
  selectedValueIndex = i;
  selectedListItemIndex = 0;
  updateValueNavActive(i);
  valueNavScrollLock = true;

  if (valueNavScrollLockTimer) { clearTimeout(valueNavScrollLockTimer); }

  scrollToValueRow(i, true);
  valueNavScrollLockTimer = setTimeout(function () {
    valueNavScrollLock = false;
    valueNavScrollLockTimer = null;
  }, 500);
}

function syncValueNavFromScroll() {
  if (valueNavScrollLock) { return; }

  const detail = document.querySelector('.ve-values-detail');

  if (!detail) { return; }

  const anchors = detail.querySelectorAll('.ve-values-anchor[data-value-index]');

  if (!anchors.length) { return; }

  const nearBottom = detail.scrollTop + detail.clientHeight >= detail.scrollHeight - 4;
  let current;

  if (nearBottom) {
    current = Number(anchors[anchors.length - 1].dataset.valueIndex);
  } else {
    const threshold = detail.getBoundingClientRect().top + 24;

    current = Number(anchors[0].dataset.valueIndex) || 0;
    Array.prototype.forEach.call(anchors, function (el) {
      if (el.getBoundingClientRect().top <= threshold) {
        current = Number(el.dataset.valueIndex);
      }
    });
  }

  if (current !== selectedValueIndex) {
    selectedValueIndex = current;
    updateValueNavActive(current);
  }
}

function bindValuesDetailScroll() {
  const detail = document.querySelector('.ve-values-detail');

  if (!detail || detail.dataset.scrollBound === '1') { return; }

  detail.dataset.scrollBound = '1';
  detail.addEventListener('scroll', syncValueNavFromScroll, { passive: true });
}

function renderValuesTab() {
  if (!valuesState) { return renderSkeleton(); }

  if (valuesRawMode) {
    return \`
      <div class="raw-toggle">
        <button class="btn btn-sm" onclick="toggleValuesRawMode()">Switch to table view</button>
        <button class="btn btn-sm" onclick="downloadValuesJson()">Save to JSON file…</button>
        <button class="btn btn-sm" onclick="triggerImportValuesJson()">Import from JSON file…</button>
        <input type="file" id="import-values-file" accept="application/json,.json" style="display:none" onchange="onImportValuesFile(this)" />
      </div>
      <textarea class="raw-editor" id="values-raw-editor" spellcheck="false" oninput="onValuesRawInput()">\${escapeHtml(JSON.stringify(toExportableValueRows(valueRows), null, 2))}</textarea>
      <div id="values-raw-issues"></div>
      <div class="hint">Editing the raw JSON directly. Must be an array of { name, value } entries — value may be a native JSON array for list-type variables (converted to MI's plain-string form on save).</div>
    \`;
  }

  if (!valueRows.length) {
    return \`
      <div class="raw-toggle">
        <button class="btn btn-sm" onclick="toggleValuesRawMode()">View/edit raw JSON</button>
        <button class="btn btn-sm" onclick="openImportValuesModal()">⇄ Import from page…</button>
      </div>
      <div class="ve-values-layout">
        <div class="ve-values-nav">
          <div class="ve-values-nav-list"></div>
          <button type="button" class="ve-values-nav-item ve-values-nav-add" onclick="addValueRow()">+ Add item</button>
        </div>
        <div class="ve-values-detail box-style"><div class="ve-values-empty">No variables yet.</div></div>
      </div>
    \`;
  }

  if (selectedValueIndex < 0 || selectedValueIndex >= valueRows.length) {
    selectedValueIndex = 0;
  }

  const navHtml = valueRows.map((row, i) => valuesNavItemHtml(row, i, i === selectedValueIndex)).join('');
  const detailHtml = valueRows.map((row, i) =>
    '<div class="ve-values-anchor box-style' + (i === selectedValueIndex ? ' is-active' : '') + '" id="value-item-' + i + '" data-value-index="' + i + '">' + valuesDetailHtml(row, i) + '</div>'
  ).join('');

  return \`
    <div class="raw-toggle">
      <button class="btn btn-sm" onclick="toggleValuesRawMode()">View/edit raw JSON</button>
      <button class="btn btn-sm" onclick="openImportValuesModal()">⇄ Import from page…</button>
    </div>
    <div class="ve-values-layout">
      <div class="ve-values-nav">
        <div class="ve-values-nav-list">\${navHtml}</div>
      </div>
      <div class="ve-values-detail">\${detailHtml}</div>
    </div>
  \`;
}

function toggleValuesRawMode() {
  if (valuesRawMode) {
    // Leaving raw mode: try to parse back into rows; keep raw mode on failure. The value field
    // may be a native JSON array (list-type) as well as a plain string — see toExportableValueRows().
    const editorEl = document.getElementById('values-raw-editor');
    const editorText = editorEl ? editorEl.value : JSON.stringify(toExportableValueRows(valueRows));

    try {
      const parsed = JSON.parse(editorText);

      if (
        !Array.isArray(parsed) ||
        parsed.some((e) => typeof e !== 'object' || e === null || typeof e.name !== 'string' || e.value === undefined || e.value === null)
      ) {
        throw new Error('Must be an array of { name, value } entries with non-empty names and a defined value.');
      }

      valueRows = fromExportableValueRows(parsed);
    } catch (e) {
      // showBanner() re-renders, which would otherwise regenerate this textarea from the last
      // known-good valueRows — put the user's (still-broken) text back afterward so their
      // in-progress edit isn't silently discarded.
      showBanner('error', 'Cannot switch to table view: ' + escapeHtml(e.message));

      const freshEditorEl = document.getElementById('values-raw-editor');

      if (freshEditorEl) { freshEditorEl.value = editorText; }

      return;
    }
  }

  valuesRawMode = !valuesRawMode;
  setUrlState(activeTab, valuesRawMode);
  render();
}

function updateValueField(i, value) {
  valueRows[i].value = value;
  setDirty(true);
}

// ── Values tab: "Import from page…" ─────────────────────────────────────────
// Two-step flow, both steps rendered into the same overlay element (only its innerHTML swaps)
// so the outer overlay's click-outside/Escape handlers, bound once here, keep working through
// "← Back". Nothing is written to MI until the user then hits the regular Save button.
function openImportValuesModal() {
  closeImportModal();

  const overlay = document.createElement('div');

  overlay.className = 've-modal-overlay';
  overlay.id = 've-import-overlay';

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) { closeImportModal(); }
  });
  overlay.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeImportModal();
    }
  });

  document.body.appendChild(overlay);
  renderImportPickerStep(overlay);
}

function closeImportModal() {
  const overlay = document.getElementById('ve-import-overlay');

  if (overlay) { overlay.remove(); }
}

function backToImportPicker() {
  const overlay = document.getElementById('ve-import-overlay');

  if (overlay) { renderImportPickerStep(overlay); }
}

async function renderImportPickerStep(overlay) {
  overlay.innerHTML =
    '<div class="ve-modal ve-modal-wide" role="dialog" aria-modal="true">' +
    '<div class="ve-modal-title-row">' +
    '<div class="ve-modal-title">Import values from another page</div>' +
    '<button type="button" class="btn btn-sm ve-modal-close" title="Close" aria-label="Close" onclick="closeImportModal()">✕</button>' +
    '</div>' +
    '<div class="ve-modal-body"><span class="ve-loading-indicator"><span class="ve-loading-dot"></span>Loading pages…</span></div>' +
    '</div>';

  let r;

  try {
    r = await fetch('/@api/variables/pages');
  } catch (e) {
    setImportBodyError(overlay, e.message);

    return;
  }

  const data = await r.json().catch(() => ({}));

  if (!overlay.isConnected) { return; }

  if (!r.ok) {
    setImportBodyError(overlay, data.error || 'Failed to load the page list.');

    return;
  }

  const bodyEl = overlay.querySelector('.ve-modal-body');

  if (!bodyEl) { return; }

  bodyEl.innerHTML = importPickerBodyHtml(data.pages || []);

  const filterEl = document.getElementById('ve-import-filter');

  if (filterEl) { filterEl.focus(); }
}

function setImportBodyError(overlay, message) {
  if (!overlay.isConnected) { return; }

  const bodyEl = overlay.querySelector('.ve-modal-body');

  if (bodyEl) { bodyEl.innerHTML = '<div class="hint" style="color:var(--red)">' + escapeHtml(message) + '</div>'; }
}

function importPickerBodyHtml(pages) {
  if (!pages.length) {
    return '<div class="ve-import-empty">No other pages found on this instance.</div>';
  }

  const sameTemplate = pages.filter((p) => p.sameTemplate);
  const other = pages.filter((p) => !p.sameTemplate);

  return (
    '<div class="ve-import-search"><input type="text" id="ve-import-filter" placeholder="Filter pages…" oninput="filterImportPages(this.value)" autocomplete="off" /></div>' +
    importPageGroupHtml('Pages using this template', sameTemplate) +
    importPageGroupHtml('Other pages', other) +
    '<div class="ve-import-empty" id="ve-import-page-empty" style="display:none">No pages match your filter.</div>'
  );
}

function importPageGroupHtml(title, pages) {
  if (!pages.length) { return ''; }

  const rows = pages
    .map(
      (p) =>
        '<button type="button" class="ve-import-page-row" data-search="' +
        escapeHtml((p.name + ' ' + p.internal_name).toLowerCase()) +
        '" onclick="selectImportSourcePage(' + p.id + ', \\'' + escapeJsAttr(p.name) + '\\')">' +
        '<span class="ve-import-page-name">' + escapeHtml(p.name) + '</span>' +
        '<span class="ve-import-page-slug">' + escapeHtml(p.internal_name) + '</span>' +
        '</button>',
    )
    .join('');

  return (
    '<div class="ve-import-page-group">' +
    '<div class="ve-import-section-title">' + escapeHtml(title) + '</div>' +
    '<div class="ve-import-page-list">' + rows + '</div>' +
    '</div>'
  );
}

function filterImportPages(text) {
  const needle = text.trim().toLowerCase();
  let visible = 0;

  Array.prototype.forEach.call(document.querySelectorAll('.ve-import-page-row'), function (row) {
    const match = !needle || row.dataset.search.indexOf(needle) !== -1;

    row.style.display = match ? '' : 'none';

    if (match) { visible++; }
  });

  Array.prototype.forEach.call(document.querySelectorAll('.ve-import-page-group'), function (group) {
    const anyVisible = Array.prototype.some.call(group.querySelectorAll('.ve-import-page-row'), function (row) {
      return row.style.display !== 'none';
    });

    group.style.display = anyVisible ? '' : 'none';
  });

  const emptyEl = document.getElementById('ve-import-page-empty');

  if (emptyEl) { emptyEl.style.display = visible === 0 ? '' : 'none'; }
}

async function selectImportSourcePage(pageId, pageName) {
  const overlay = document.getElementById('ve-import-overlay');

  if (!overlay) { return; }

  overlay.dataset.sourcePageId = String(pageId);

  overlay.innerHTML =
    '<div class="ve-modal ve-modal-wide" role="dialog" aria-modal="true">' +
    '<div class="ve-modal-title-row">' +
    '<div style="flex:1;min-width:0">' +
    '<button type="button" class="ve-modal-back" onclick="backToImportPicker()">← Back</button>' +
    '<div class="ve-modal-title" style="margin-bottom:0">Import values from "' + escapeHtml(pageName) + '"</div>' +
    '</div>' +
    '<button type="button" class="btn btn-sm ve-modal-close" title="Close" aria-label="Close" onclick="closeImportModal()">✕</button>' +
    '</div>' +
    '<div class="ve-modal-body"><span class="ve-loading-indicator"><span class="ve-loading-dot"></span>Loading values…</span></div>' +
    '<div class="ve-modal-actions" id="ve-import-actions"></div>' +
    '</div>';

  let r;

  try {
    r = await fetch('/@api/variables/import-plan/' + pageId);
  } catch (e) {
    setImportBodyError(overlay, e.message);

    return;
  }

  const data = await r.json().catch(() => ({}));

  // A newer pick (or Back) landed before this one resolved — drop the stale response.
  if (!overlay.isConnected || overlay.dataset.sourcePageId !== String(pageId)) { return; }

  if (!r.ok) {
    setImportBodyError(overlay, data.error || 'Failed to load values from this page.');

    return;
  }

  const bodyEl = overlay.querySelector('.ve-modal-body');
  const actionsEl = overlay.querySelector('#ve-import-actions');

  if (!bodyEl || !actionsEl) { return; }

  importReviewCandidates = data.importable || [];
  importReviewPageName = pageName;

  bodyEl.innerHTML = importReviewBodyHtml(data);
  actionsEl.innerHTML = importReviewActionsHtml(data);

  const applyBtn = document.getElementById('ve-import-apply-btn');

  if (applyBtn) { applyBtn.focus(); }
}

function importReviewBodyHtml(plan) {
  const importable = plan.importable || [];
  const skipped = plan.skipped || [];

  if (!importable.length && !skipped.length) {
    return '<div class="ve-import-empty">This page has no live variable values to import.</div>';
  }

  let html = '';

  if (importable.length) {
    html +=
      '<div class="ve-import-list-head">' +
      '<span class="badge">Importable (' + importable.length + ')</span>' +
      '<label class="ve-import-select-all"><input type="checkbox" id="ve-import-select-all" checked onchange="toggleImportAll(this.checked)" /> select all</label>' +
      '</div>' +
      '<div class="ve-import-list">' + importable.map((c, i) => importRowHtml(c, i)).join('') + '</div>';
  } else {
    html += '<div class="hint">Nothing on this page matches a variable name in the current schema.</div>';
  }

  if (skipped.length) {
    html +=
      '<div class="ve-import-section-title">Skipped (' + skipped.length + ')</div>' +
      '<div class="ve-import-list">' +
      skipped
        .map(
          (s) =>
            '<div class="ve-import-skip-row">' +
            '<span class="ve-import-row-name">' + escapeHtml(s.name) + '</span>' +
            '<span class="ve-import-skip-reason">' + escapeHtml(s.reason) + '</span>' +
            '</div>',
        )
        .join('') +
      '</div>';
  }

  return html;
}

function importRowHtml(candidate, i) {
  return (
    '<label class="ve-import-row">' +
    '<input type="checkbox" class="ve-import-check" data-index="' + i + '" checked onchange="updateImportCount()" />' +
    '<span class="ve-import-row-main">' +
    '<span class="ve-import-row-top"><span class="ve-import-row-name">' + escapeHtml(candidate.name) + '</span>' + typeBadgeHtml(candidate.tagType) + '</span>' +
    '<span class="ve-import-row-value">' + importValuePreviewHtml(candidate) + '</span>' +
    '</span>' +
    '</label>'
  );
}

function importValuePreviewHtml(candidate) {
  const raw = candidate.sourceValue || '';

  if (candidate.tagType === 'color' && /^#[0-9a-fA-F]{3,8}$/.test(raw)) {
    return '<span class="ve-import-swatch" style="background:' + raw + '"></span>' + escapeHtml(raw);
  }

  const preview = raw.length > 80 ? raw.slice(0, 80) + '…' : raw;

  return escapeHtml(preview || '(empty)');
}

function importReviewActionsHtml(plan) {
  const count = (plan.importable || []).length;

  if (!count) {
    return '<button type="button" class="btn btn-sm" onclick="closeImportModal()">Close</button>';
  }

  return (
    '<span class="hint" id="ve-import-count" style="margin-right:auto">' + count + ' of ' + count + ' selected</span>' +
    '<button type="button" class="btn btn-sm" onclick="closeImportModal()">Cancel</button>' +
    '<button type="button" class="btn btn-sm btn-primary" id="ve-import-apply-btn" onclick="applyImportPlan()">Apply ' + count + ' selected</button>'
  );
}

function toggleImportAll(checked) {
  Array.prototype.forEach.call(document.querySelectorAll('.ve-import-check'), function (c) { c.checked = checked; });
  updateImportCount();
}

function updateImportCount() {
  const checks = document.querySelectorAll('.ve-import-check');
  const checkedCount = document.querySelectorAll('.ve-import-check:checked').length;
  const countEl = document.getElementById('ve-import-count');
  const selectAllEl = document.getElementById('ve-import-select-all');
  const applyBtn = document.getElementById('ve-import-apply-btn');

  if (countEl) { countEl.textContent = checkedCount + ' of ' + checks.length + ' selected'; }
  if (selectAllEl) { selectAllEl.checked = checkedCount === checks.length; }

  if (applyBtn) {
    applyBtn.textContent = 'Apply ' + checkedCount + ' selected';
    applyBtn.disabled = checkedCount === 0;
  }
}

function applyImportPlan() {
  const checkedIndexes = Array.prototype.map.call(document.querySelectorAll('.ve-import-check:checked'), function (c) {
    return Number(c.dataset.index);
  });

  let applied = 0;

  checkedIndexes.forEach((idx) => {
    const candidate = importReviewCandidates[idx];

    if (!candidate) { return; }

    const row = valueRows.find((r) => r.name === candidate.name);

    if (!row) { return; }

    row.value = candidate.sourceValue;
    applied++;
  });

  const total = importReviewCandidates.length;
  const pageName = importReviewPageName;

  closeImportModal();

  if (!applied) { return; }

  setDirty(true);
  showBanner('success', 'Imported ' + applied + ' of ' + total + ' variable(s) from "' + escapeHtml(pageName) + '". Save to apply.');
}

function addValueRow() {
  showCustomValueModal('Variable name', '', (name) => {
    if (!name) { return; }

    valueRows.push({ name, value: '' });
    selectedValueIndex = valueRows.length - 1;
    selectedListItemIndex = 0;
    setDirty(true);
    render();
  });
}

function removeValueRow(i) {
  const name = (valueRows[i] && valueRows[i].name) || '(unnamed)';

  showConfirmModal('Delete variable "' + name + '"? This only takes effect once you Save.', () => {
    valueRows.splice(i, 1);
    selectedValueIndex = Math.min(i, Math.max(0, valueRows.length - 1));
    selectedListItemIndex = 0;
    setDirty(true);
    render();
  });
}

async function saveValues() {
  if (!valuesState) {
    showBanner('error', 'Cannot save values until live variables have loaded successfully.');

    return;
  }

  let tags = valueRows;
  const beforeText = jsonBaseline.values;

  if (valuesRawMode) {
    try {
      // The textarea may contain native JSON arrays for list-type values (see
      // toExportableValueRows()) — convert back to MI's plain-string form before sending.
      tags = fromExportableValueRows(JSON.parse(document.getElementById('values-raw-editor').value));
    } catch (e) {
      showBanner('error', 'Raw JSON is not valid: ' + escapeHtml(e.message));

      return;
    }
  }

  const afterText = snapshotValuesJson(tags);

  if (normalizeJsonText(beforeText) === normalizeJsonText(afterText)) {
    setDirty(false);
    showBanner('success', 'No JSON changes to save.');

    return;
  }

  showJsonDiffModal(beforeText, afterText, () => commitValuesSave(tags, afterText));
}

async function commitValuesSave(tags, afterText) {
  const saveEditSeq = editSeq;
  const r = await fetch('/@api/variables/values', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags }),
  });
  const data = await r.json();

  if (!r.ok) {
    showBanner('error', escapeHtml(data.error || 'Save failed.'));

    return;
  }

  const warnings = data.warnings || [];
  const hasNewerEdits = editSeq !== saveEditSeq;
  const message = warnings.length
    ? 'Saved, with warning(s):<ul>' + warnings.map((w) => '<li>' + escapeHtml(w.message) + '</li>').join('') + '</ul>'
    : 'Values saved.';

  if (hasNewerEdits) {
    showBanner('warning', message + '<div>Newer edits remain unsaved.</div>', true);

    return;
  }

  setDirty(false);
  showBanner(warnings.length ? 'warning' : 'success', message);
  jsonBaseline.values = afterText;

  await loadTabData('values');
  render();
}

function save() {
  (activeTab === 'schema' ? saveSchema() : saveValues());
}

// ── Render ───────────────────────────────────────────────────────────────────
function render() {
  const bannerHtml = banner ? '<div class="banner banner-' + banner.type + '">' + banner.html + '</div>' : '';

  contentEl.innerHTML = bannerHtml + (activeTab === 'schema' ? renderSchemaTab() : renderValuesTab());
  autosizeAllCellTextareas();

  if (activeTab === 'values' && !valuesRawMode) {
    bindValuesDetailScroll();
    scrollToValueRow(selectedValueIndex, false);
  }

  if (activeTab === 'values' && valuesRawMode) {
    refreshValuesJsonIssues();
  }

  const loadingEl = document.getElementById('loading-indicator');

  if (loadingEl) {
    // Only surface the indicator when there's cached content already on screen underneath it —
    // when there isn't (state is still null), renderSkeleton() above is the loading signal.
    const stateForTab = activeTab === 'schema' ? schemaState : valuesState;
    const isLoading = activeTab === 'schema' ? schemaLoading : valuesLoading;

    loadingEl.style.display = isLoading && stateForTab ? '' : 'none';
  }
}

window.switchTab = switchTab;
window.refresh = refresh;
window.save = save;
window.toggleRawMode = toggleRawMode;
window.updateSchemaField = updateSchemaField;
window.autosizeCellTextarea = autosizeCellTextarea;
window.onCustomSelectChange = onCustomSelectChange;
window.updateSchemaAdditionalOptions = updateSchemaAdditionalOptions;
window.updateEditorFlag = updateEditorFlag;
window.showAdditionalOptionsHelp = showAdditionalOptionsHelp;
window.showListColumnsHelp = showListColumnsHelp;
window.addListColumn = addListColumn;
window.removeListColumn = removeListColumn;
window.reorderListColumn = reorderListColumn;
window.onListColumnDragStart = onListColumnDragStart;
window.onListColumnDragOver = onListColumnDragOver;
window.onListColumnDragLeave = onListColumnDragLeave;
window.onListColumnDrop = onListColumnDrop;
window.onListColumnDragEnd = onListColumnDragEnd;
window.updateListColumnField = updateListColumnField;
window.updateListColumnOptions = updateListColumnOptions;
window.toggleSchemaAdvanced = toggleSchemaAdvanced;
window.addSchemaRow = addSchemaRow;
window.removeSchemaRow = removeSchemaRow;
window.reorderSchemaRow = reorderSchemaRow;
window.onSchemaRowDragStart = onSchemaRowDragStart;
window.onSchemaRowDragOver = onSchemaRowDragOver;
window.onSchemaRowDragLeave = onSchemaRowDragLeave;
window.onSchemaRowDrop = onSchemaRowDrop;
window.onSchemaRowDragEnd = onSchemaRowDragEnd;
window.updateValueField = updateValueField;
window.selectValueRow = selectValueRow;
window.addValueRow = addValueRow;
window.removeValueRow = removeValueRow;
window.toggleValuesRawMode = toggleValuesRawMode;
window.onValuesRawInput = onValuesRawInput;
window.downloadValuesJson = downloadValuesJson;
window.triggerImportValuesJson = triggerImportValuesJson;
window.onImportValuesFile = onImportValuesFile;
window.onComboFocus = onComboFocus;
window.onComboBlur = onComboBlur;
window.onComboFilter = onComboFilter;
window.onSingleComboInput = onSingleComboInput;
window.onComboOptionPick = onComboOptionPick;
window.onChipRemove = onChipRemove;
window.addListItem = addListItem;
window.removeListItem = removeListItem;
window.reorderListItem = reorderListItem;
window.onListItemDragStart = onListItemDragStart;
window.onListItemDragOver = onListItemDragOver;
window.onListItemDragLeave = onListItemDragLeave;
window.onListItemDrop = onListItemDrop;
window.onListItemDragEnd = onListItemDragEnd;
window.updateListItemField = updateListItemField;
window.onListItemSelectChange = onListItemSelectChange;
window.openImportValuesModal = openImportValuesModal;
window.closeImportModal = closeImportModal;
window.backToImportPicker = backToImportPicker;
window.selectImportSourcePage = selectImportSourcePage;
window.filterImportPages = filterImportPages;
window.toggleImportAll = toggleImportAll;
window.updateImportCount = updateImportCount;
window.applyImportPlan = applyImportPlan;
window.setDirty = setDirty;

document.getElementById('tab-schema').classList.toggle('active', activeTab === 'schema');
document.getElementById('tab-values').classList.toggle('active', activeTab === 'values');
setUrlState(activeTab, valuesRawMode);

// Skeleton first (nothing's cached yet on a fresh page load), then swap in the real content.
render();
loadTabData(activeTab).then(render);
})();
</script>
</body>
</html>`;
}
