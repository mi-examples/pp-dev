// The Variables Editor page (`/@pp-dev/variables-editor`): the page's template variables
// (Schema tab, `__template_variables.json`) and their live values in MI (Values tab). main.ts
// starts it on variables-editor.html. The HTML comes from schema-tab.ts, values-tab.ts and
// import-modal.ts; its controls say what they do in `data-action`, handled here in one place.
import { applyTheme, getStoredTheme, setTheme, type ThemeChoice } from '../theme.js';
import { errorMessage, escapeHtml } from './html.js';
import {
  importErrorHtml,
  importPickerBodyHtml,
  importPickerStepHtml,
  importReviewActionsHtml,
  importReviewBodyHtml,
  importReviewStepHtml,
} from './import-modal.js';
import {
  normalizeJsonText,
  showConfirmModal,
  showCustomValueModal,
  showInfoModal,
  showJsonDiffModal,
} from './modals.js';
import {
  CUSTOM_TYPE_SENTINEL,
  LIST_COLUMNS_HELP_HTML,
  additionalOptionsDetails,
  listColumnsFor,
  newUid,
  normalizeListColumn,
  renderSchemaTabHtml,
} from './schema-tab.js';
import type {
  EditorFlagField,
  ErrorBody,
  ExportableValueRow,
  ImportCandidate,
  ImportPlan,
  ListColumn,
  LocalValuesResponse,
  PagesResponse,
  SchemaChoiceField,
  SchemaSaveResponse,
  SchemaState,
  SchemaTag,
  SchemaTextField,
  ValueRow,
  ValuesSaveResponse,
  ValuesState,
} from './types.js';
import {
  chipHtml,
  fromExportableValueRows,
  listConfigFor,
  parseListItems,
  renderJsonIssuesBar,
  renderValuesTabHtml,
  schemaTagFor,
  toExportableValueRows,
} from './values-tab.js';

type Tab = 'schema' | 'values';
type BannerType = 'error' | 'success' | 'warning';
/** A control whose `value` the editor reads. */
type FieldElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const TEMPLATE_LESS_MESSAGE =
  '<div class="empty-state">This page has no associated template — there\'s no <code>__template_variables.json</code> and no page variables to edit here.</div>';
const AUTO_LOAD_DEBOUNCE_MS = 200;

// Lets a link like /@pp-dev/variables-editor?tab=values open directly on that tab.
function tabFromUrl(): Tab {
  return new URLSearchParams(window.location.search).get('tab') === 'values' ? 'values' : 'schema';
}

// Values tab's raw/JSON mode is also linkable — /@pp-dev/variables-editor?tab=values&mode=json.
function valuesJsonModeFromUrl(): boolean {
  return new URLSearchParams(window.location.search).get('mode') === 'json';
}

function setUrlState(tab: Tab, valuesJsonMode: boolean) {
  const url = new URL(window.location.href);

  url.searchParams.set('tab', tab);

  if (tab === 'values' && valuesJsonMode) {
    url.searchParams.set('mode', 'json');
  } else {
    url.searchParams.delete('mode');
  }

  history.replaceState(null, '', url);
}

function autosizeCellTextarea(el: HTMLElement) {
  const type = (el as HTMLInputElement).type;

  if (type === 'color' || type === 'checkbox') {
    return;
  }

  el.style.height = '0';
  el.style.height = Math.max(30, el.scrollHeight) + 'px';
}

function autosizeAllCellTextareas() {
  document
    .querySelectorAll<HTMLElement>(
      '.cell-textarea, .ve-list-field textarea, .ve-list-field input[type=text], .ve-list-field select, .ve-values-field textarea, .ve-values-field input[type=text], .ve-values-field select',
    )
    .forEach((el) => autosizeCellTextarea(el));
}

/** Starts the editor on the current document; returns a function that stops it (its listeners). */
export function startVariablesEditor({ templateLess }: { templateLess: boolean }): () => void {
  const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;

  // ── Theme (Auto/Dark/Light) ────────────────────────────────────────────────
  // Runs unconditionally — before the templateLess early-return below — so the switcher works
  // even on the info-only page. The <head> inline script already set data-pp-dev-theme before
  // first paint; this keeps the toolbar buttons in step. Shared with the dev panel and the Request
  // Inspector (see ../theme.ts), so picking a theme in any of them carries over to the others.
  const showTheme = (theme: ThemeChoice) => {
    applyTheme(theme);

    for (const button of Array.from(byId('theme-switch')?.children ?? []) as HTMLElement[]) {
      const isActive = button.dataset.themeChoice === theme;

      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    }
  };

  const onThemeClick = (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-theme-choice]') : null;

    if (button) {
      const theme = button.dataset.themeChoice as ThemeChoice;

      setTheme(theme);
      showTheme(theme);
    }
  };

  showTheme(getStoredTheme());
  document.addEventListener('click', onThemeClick);

  const contentEl = byId<HTMLDivElement>('content')!;

  // No template: no tabs, no Refresh/Save (hidden by the page's CSS), just the message.
  if (templateLess) {
    contentEl.innerHTML = TEMPLATE_LESS_MESSAGE;

    return () => document.removeEventListener('click', onThemeClick);
  }

  let activeTab = tabFromUrl();
  let schemaState: SchemaState | null = null;
  let valuesState: ValuesState | null = null;
  let schemaRows: SchemaTag[] = []; // working copy of tags, edited in place
  const invalidAdditionalOptionsRows = new WeakSet<SchemaTag>();
  let valueRows: ValueRow[] = []; // working copy of {name, value}
  let selectedValueIndex = 0;
  let importReviewCandidates: ImportCandidate[] = []; // last-fetched import-plan's "importable" list, for applyImportPlan()
  let importReviewPageName = ''; // source page name, for the post-apply banner
  let valuesRawMode = activeTab === 'values' && valuesJsonModeFromUrl();
  let rawMode = false;
  let dirty = false;
  let editSeq = 0;
  let banner: { type: BannerType; html: string } | null = null;
  // Last-known saved JSON for each tab — used to build the post-save GitHub-style diff.
  const jsonBaseline = { schema: '', values: '' };

  // Background-refresh bookkeeping, one pair of (loading flag, sequence counter) per tab: a
  // stale response (superseded by a newer load for the SAME tab before it resolved) is dropped
  // rather than clobbering fresher data — see loadTabData().
  let schemaLoading = false;
  let valuesLoading = false;
  let schemaSeq = 0;
  let valuesSeq = 0;
  let autoLoadTimer: ReturnType<typeof setTimeout> | null = null;

  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  };

  window.addEventListener('beforeunload', onBeforeUnload);

  function setDirty(v: boolean) {
    dirty = v;

    if (v) {
      editSeq += 1;
    }
  }

  function showBanner(type: BannerType, html: string, preserveContent?: boolean) {
    banner = { type, html };

    if (preserveContent) {
      const existingBanner = contentEl.querySelector(':scope > .banner');
      const bannerEl = document.createElement('div');

      if (existingBanner) {
        existingBanner.remove();
      }

      bannerEl.className = 'banner banner-' + type;
      bannerEl.innerHTML = html;
      contentEl.prepend(bannerEl);

      return;
    }

    render();
  }

  function clearBanner() {
    banner = null;
  }

  // ── Data loading ─────────────────────────────────────────────────────────────
  async function loadSchema(seq: number) {
    let r: Response;
    let data: SchemaState & ErrorBody;

    try {
      r = await fetch('/@api/variables/schema');
      data = (await r.json()) as SchemaState & ErrorBody;
    } catch (e) {
      if (seq !== schemaSeq) {
        return;
      }

      showBanner('error', 'Failed to load the schema: ' + escapeHtml(errorMessage(e)));

      return;
    }

    if (seq !== schemaSeq) {
      return;
    }

    // An error answer (e.g. 503 with no dist service) is not a schema: kept as one, it rendered as
    // "No local __template_variables.json found" and offered to create a file over the real one.
    if (!r.ok) {
      schemaState = null;
      schemaRows = [];
      showBanner('error', 'Failed to load the schema: ' + escapeHtml((data && data.error) || 'HTTP ' + r.status));

      return;
    }

    schemaState = data;
    schemaRows =
      data.schema && Array.isArray(data.schema.tags) ? data.schema.tags.map((t) => Object.assign({}, t)) : [];
    rawMode = data.exists && !data.schema;
    jsonBaseline.schema = snapshotSchemaJson();
  }

  async function loadValues(seq: number) {
    let r: Response;

    try {
      r = await fetch('/@api/variables/values');
    } catch (e) {
      if (seq !== valuesSeq) {
        return;
      }

      valuesState = null;
      valueRows = [];
      showBanner('error', 'Failed to load values: ' + escapeHtml(errorMessage(e)));

      return;
    }

    if (!r.ok) {
      const err = (await r.json().catch(() => ({}))) as ErrorBody;

      if (seq !== valuesSeq) {
        return;
      }

      // A save is a full replacement. Keep the state explicitly unavailable after a failed
      // read so the user cannot accidentally submit an empty replacement set.
      valuesState = null;
      valueRows = [];
      showBanner('error', escapeHtml(err.error || 'Failed to load values.'));

      return;
    }

    let data: ValuesState;

    try {
      data = (await r.json()) as ValuesState;
    } catch (e) {
      if (seq !== valuesSeq) {
        return;
      }

      valuesState = null;
      valueRows = [];
      showBanner('error', 'Failed to parse the values response: ' + escapeHtml(errorMessage(e)));

      return;
    }

    if (seq !== valuesSeq) {
      return;
    }

    valuesState = data;
    valueRows = (data.combined || []).map((e) => Object.assign({}, e));
    jsonBaseline.values = snapshotValuesJson();
  }

  function snapshotSchemaJson(): string {
    if (!schemaState) {
      return '';
    }

    if (rawMode) {
      const editorEl = byId<HTMLTextAreaElement>('raw-editor');

      return editorEl ? editorEl.value : schemaState.raw || '';
    }

    if (schemaState.raw && (!schemaState.schema || !Array.isArray(schemaRows))) {
      return schemaState.raw;
    }

    try {
      return JSON.stringify(Object.assign({}, schemaState.schema || {}, { tags: schemaRows }), null, 2);
    } catch {
      return schemaState.raw || '';
    }
  }

  function snapshotValuesJson(rows?: ValueRow[]): string {
    try {
      return JSON.stringify(toExportableValueRows(rows || valueRows, valuesState), null, 2);
    } catch {
      return '[]';
    }
  }

  // Fetches fresh data for one tab, tracking a per-tab "loading" flag and sequence number so a
  // response that's superseded by a newer load for the SAME tab (started before this one
  // resolved) gets dropped instead of clobbering fresher data. Toggles the tab's own loading
  // flag but deliberately doesn't call render() itself — callers decide when to repaint.
  function loadTabData(tab: Tab): Promise<void> {
    if (tab === 'schema') {
      const seq = ++schemaSeq;

      schemaLoading = true;

      return loadSchema(seq).then(() => {
        if (seq === schemaSeq) {
          schemaLoading = false;
        }
      });
    }

    const seq = ++valuesSeq;

    valuesLoading = true;

    return loadValues(seq).then(() => {
      if (seq === valuesSeq) {
        valuesLoading = false;
      }
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
      showConfirmModal('Discard unsaved changes?', () => void doRefresh());

      return;
    }

    void doRefresh();
  }

  // Debounces the network round-trip that automatically follows a tab switch: rapidly flipping
  // between tabs (or landing on one only to immediately leave it) only fires the load that's
  // still pending once things settle, rather than one request per click.
  function scheduleAutoLoad(tab: Tab) {
    if (autoLoadTimer) {
      clearTimeout(autoLoadTimer);
    }

    autoLoadTimer = setTimeout(() => {
      autoLoadTimer = null;

      // loadTabData() flips the tab's loading flag synchronously before its fetch resolves, so
      // render() has to run AFTER this call starts (not before) for the indicator to reflect it.
      const pending = loadTabData(tab);

      if (activeTab === tab) {
        render();
      }

      void pending.then(() => {
        if (activeTab === tab) {
          render();
        }
      });
    }, AUTO_LOAD_DEBOUNCE_MS);
  }

  function doSwitchTab(tab: Tab) {
    activeTab = tab;
    setDirty(false);
    clearBanner();

    // Switching tabs by hand always starts the Values tab in table view — only a direct link
    // (?tab=values&mode=json, handled at bootstrap) opens straight into raw/JSON mode.
    if (tab === 'values') {
      valuesRawMode = false;
    }

    setUrlState(tab, valuesRawMode);

    byId('tab-schema')!.classList.toggle('active', tab === 'schema');
    byId('tab-values')!.classList.toggle('active', tab === 'values');

    // Paint immediately with whatever's already cached for this tab (or a skeleton, if it's
    // never been loaded) instead of leaving the previous tab's content on screen until the
    // debounced fetch below resolves.
    render();
    scheduleAutoLoad(tab);
  }

  function switchTab(tab: Tab) {
    if (dirty) {
      showConfirmModal('Discard unsaved changes and switch tabs?', () => doSwitchTab(tab));

      return;
    }

    doSwitchTab(tab);
  }

  // ── Schema tab ───────────────────────────────────────────────────────────────
  function showAdditionalOptionsHelp(i: number) {
    const tag = schemaRows[i];

    // showInfoModal() escapes the title itself.
    showInfoModal(
      'additional_options — ' + (tag.tag_type || 'text') + (tag.tag_source ? ' / ' + tag.tag_source : ''),
      additionalOptionsDetails(tag),
    );
  }

  // Re-renders the whole schema table (needed because changing tag_type/tag_source/an editor
  // flag can change which OTHER fields this same row should show), then restores row i's
  // advanced panel to whatever open/closed state it was in — render() always starts it closed.
  function rerenderKeepingAdvancedOpen(i: number) {
    const before = byId('advanced-' + i);
    const wasOpen = !!before && before.style.display !== 'none';

    render();

    if (wasOpen) {
      const after = byId('advanced-' + i);
      const btn = byId('expand-btn-' + i);

      if (after) {
        after.style.display = '';
      }

      if (btn) {
        btn.textContent = '▾';
        btn.setAttribute('aria-expanded', 'true');
      }
    }
  }

  function updateEditorFlag(i: number, field: EditorFlagField, checked: boolean) {
    schemaRows[i][field] = checked ? 'Y' : 'N';

    // Matches MI's own form: turning WYSIWYG on is exclusive with Raw HTML / JSON Editor.
    if (field === 'use_hmtl_editor_ind' && checked) {
      schemaRows[i].use_raw_html_ind = 'N';
      schemaRows[i].use_json_editor_ind = 'N';
    }

    setDirty(true);
    rerenderKeepingAdvancedOpen(i);
  }

  function onCustomSelectChange(i: number, selectEl: HTMLSelectElement, field: SchemaChoiceField) {
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

  function toggleRawMode() {
    if (!schemaState) {
      return;
    }

    if (!rawMode) {
      // Entering raw mode: serialize the current table state so edits aren't lost.
      schemaState.raw = JSON.stringify(Object.assign({}, schemaState.schema, { tags: schemaRows }), null, 2);
    } else {
      // Leaving raw mode: try to parse back into the table; keep raw mode on failure.
      const editorEl = byId<HTMLTextAreaElement>('raw-editor');
      const editorText = editorEl ? editorEl.value : (schemaState.raw as string);

      try {
        const parsed = JSON.parse(editorText) as SchemaState['schema'];

        if (!parsed || !Array.isArray(parsed.tags)) {
          throw new Error('Missing "tags" array');
        }

        schemaState.schema = parsed;
        schemaRows = parsed.tags.map((t) => Object.assign({}, t));
        schemaState.exists = true;
        delete schemaState.parseError;
      } catch (e) {
        // showBanner() re-renders, which would otherwise regenerate this textarea from the last
        // known-good schemaState.raw — put the user's (still-broken) text back afterward so their
        // in-progress edit isn't silently discarded.
        showBanner('error', 'Cannot switch to table view: ' + escapeHtml(errorMessage(e)));

        const freshEditorEl = byId<HTMLTextAreaElement>('raw-editor');

        if (freshEditorEl) {
          freshEditorEl.value = editorText;
        }

        return;
      }
    }

    rawMode = !rawMode;
    render();
  }

  function updateSchemaField(i: number, field: SchemaTextField | SchemaChoiceField, value: string) {
    schemaRows[i][field] = value;
    setDirty(true);
  }

  function updateSchemaAdditionalOptions(i: number, text: string) {
    try {
      schemaRows[i].additional_options = text.trim() ? JSON.parse(text) : '';
      invalidAdditionalOptionsRows.delete(schemaRows[i]);
    } catch {
      schemaRows[i].additional_options = text;
      invalidAdditionalOptionsRows.add(schemaRows[i]);
    }

    setDirty(true);
  }

  function syncAdditionalOptionsRaw(i: number) {
    const ta = byId<HTMLTextAreaElement>('ao-raw-' + i);

    if (!ta || ta.disabled) {
      return;
    }

    const value = schemaRows[i].additional_options;

    ta.value = value !== undefined && value !== '' ? JSON.stringify(value) : '';
  }

  function commitListColumns(i: number, columns: ListColumn[], rerender: boolean) {
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

  function addListColumn(i: number) {
    const cols = listColumnsFor(schemaRows[i]);

    cols.push({ name: '', type: 'textarea' });
    commitListColumns(i, cols, true);
  }

  function removeListColumn(i: number, colIndex: number) {
    const cols = listColumnsFor(schemaRows[i]);

    cols.splice(colIndex, 1);
    commitListColumns(i, cols, true);
  }

  let listColumnDrag: { row: number; fromIndex: number } | null = null;

  function onListColumnDragStart(ev: DragEvent) {
    const col = (ev.target as Element).closest<HTMLElement>('.ve-ao-column');

    if (!col) {
      return;
    }

    listColumnDrag = {
      row: Number(col.dataset.row),
      fromIndex: Number(col.dataset.colIndex),
    };
    col.classList.add('is-dragging');
    ev.dataTransfer!.effectAllowed = 'move';
    // Firefox requires setData for the drag to start.
    ev.dataTransfer!.setData('text/plain', String(listColumnDrag.fromIndex));
  }

  function onListColumnDragOver(ev: DragEvent, col: HTMLElement) {
    // Schema-row reordering can pass over list-column cards inside an open advanced panel —
    // accept the drag here so the drop isn't blocked by nested handlers.
    if (schemaRowDrag) {
      ev.preventDefault();
      ev.dataTransfer!.dropEffect = 'move';

      const details = col.closest('tr.details-row');

      if (details) {
        details.classList.add('is-drop-target');
      }

      return;
    }

    if (!listColumnDrag) {
      return;
    }

    if (Number(col.dataset.row) !== listColumnDrag.row) {
      return;
    }

    ev.preventDefault();
    ev.dataTransfer!.dropEffect = 'move';
    col.classList.add('is-drop-target');
  }

  function onListColumnDragLeave(ev: DragEvent, col: HTMLElement) {
    const related = ev.relatedTarget as Node | null;

    // Ignore leave events that stay inside the same column card (child elements).
    if (col.contains(related)) {
      return;
    }

    col.classList.remove('is-drop-target');

    if (schemaRowDrag) {
      const details = col.closest('tr.details-row');

      if (details && !details.contains(related)) {
        details.classList.remove('is-drop-target');
      }
    }
  }

  function onListColumnDrop(ev: DragEvent, col: HTMLElement) {
    ev.preventDefault();

    col.classList.remove('is-drop-target');

    if (schemaRowDrag) {
      const details = col.closest<HTMLElement>('tr.details-row');

      if (!details) {
        return;
      }

      details.classList.remove('is-drop-target');

      const toIndex = Number(details.dataset.rowIndex);
      const fromIndex = schemaRowDrag.fromIndex;

      schemaRowDrag = null;

      if (fromIndex !== toIndex) {
        reorderSchemaRow(fromIndex, toIndex);
      }

      return;
    }

    if (!listColumnDrag || Number(col.dataset.row) !== listColumnDrag.row) {
      return;
    }

    const toIndex = Number(col.dataset.colIndex);
    const fromIndex = listColumnDrag.fromIndex;

    listColumnDrag = null;

    if (fromIndex === toIndex) {
      return;
    }

    reorderListColumn(Number(col.dataset.row), fromIndex, toIndex);
  }

  function onListColumnDragEnd() {
    listColumnDrag = null;
    document.querySelectorAll('.ve-ao-column.is-dragging, .ve-ao-column.is-drop-target').forEach((el) => {
      el.classList.remove('is-dragging', 'is-drop-target');
    });
  }

  function reorderListColumn(i: number, fromIndex: number, toIndex: number) {
    const cols = listColumnsFor(schemaRows[i]);

    if (fromIndex < 0 || fromIndex >= cols.length || toIndex < 0 || toIndex >= cols.length) {
      return;
    }

    const moved = cols.splice(fromIndex, 1)[0];

    cols.splice(toIndex, 0, moved);
    commitListColumns(i, cols, true);
  }

  function updateListColumnField(i: number, colIndex: number, field: 'name' | 'type' | 'source', value: string) {
    const cols = listColumnsFor(schemaRows[i]);
    const col: ListColumn = Object.assign({ name: '', type: 'textarea' }, cols[colIndex]);

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

  function updateListColumnOptions(i: number, colIndex: number, text: string) {
    const cols = listColumnsFor(schemaRows[i]);
    const col: ListColumn = Object.assign({ name: '', type: 'textarea' }, cols[colIndex]);
    const options = text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

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

  function toggleSchemaAdvanced(i: number) {
    const row = byId('advanced-' + i)!;
    const btn = byId('expand-btn-' + i);
    const nowOpen = row.style.display === 'none';

    row.style.display = nowOpen ? '' : 'none';

    if (btn) {
      btn.textContent = nowOpen ? '▾' : '▸';
      btn.setAttribute('aria-expanded', String(nowOpen));
    }
  }

  function addSchemaRow() {
    const uid = newUid();

    schemaState!.exists = true;
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

  function removeSchemaRow(i: number) {
    const name = (schemaRows[i] && schemaRows[i].name) || '(unnamed)';

    showConfirmModal('Delete variable "' + name + '"? This only takes effect once you Save.', () => {
      schemaRows.splice(i, 1);
      setDirty(true);
      render();
    });
  }

  function schemaRowOpenKey(tag: SchemaTag, i: number): string {
    return tag && tag.uid ? String(tag.uid) : tag && tag.name ? 'name:' + tag.name : 'idx:' + i;
  }

  function collectOpenAdvancedKeys(): string[] {
    const open: string[] = [];

    schemaRows.forEach((tag, i) => {
      const el = byId('advanced-' + i);

      if (el && el.style.display !== 'none') {
        open.push(schemaRowOpenKey(tag, i));
      }
    });

    return open;
  }

  function restoreOpenAdvancedKeys(openKeys: string[]) {
    if (!openKeys || !openKeys.length) {
      return;
    }

    schemaRows.forEach((tag, i) => {
      if (openKeys.indexOf(schemaRowOpenKey(tag, i)) === -1) {
        return;
      }

      const after = byId('advanced-' + i);
      const btn = byId('expand-btn-' + i);

      if (after) {
        after.style.display = '';
      }

      if (btn) {
        btn.textContent = '▾';
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  }

  let schemaRowDrag: { fromIndex: number } | null = null;

  function onSchemaRowDragStart(ev: DragEvent) {
    const row = (ev.target as Element).closest<HTMLElement>('tr.schema-row');

    if (!row) {
      return;
    }

    const fromIndex = Number(row.dataset.rowIndex);

    schemaRowDrag = { fromIndex: fromIndex };
    row.classList.add('is-dragging');

    const details = byId('advanced-' + fromIndex);

    if (details) {
      details.classList.add('is-dragging');
    }

    ev.dataTransfer!.effectAllowed = 'move';
    // Firefox requires setData for the drag to start.
    ev.dataTransfer!.setData('text/plain', String(fromIndex));
  }

  function onSchemaRowDragOver(ev: DragEvent, row: HTMLElement) {
    if (!schemaRowDrag) {
      return;
    }

    ev.preventDefault();
    ev.dataTransfer!.dropEffect = 'move';
    row.classList.add('is-drop-target');
  }

  function onSchemaRowDragLeave(ev: DragEvent, row: HTMLElement) {
    if (row.contains(ev.relatedTarget as Node | null)) {
      return;
    }

    row.classList.remove('is-drop-target');
  }

  function onSchemaRowDrop(ev: DragEvent, row: HTMLElement) {
    ev.preventDefault();

    row.classList.remove('is-drop-target');

    if (!schemaRowDrag) {
      return;
    }

    const toIndex = Number(row.dataset.rowIndex);
    const fromIndex = schemaRowDrag.fromIndex;

    schemaRowDrag = null;

    if (fromIndex === toIndex) {
      return;
    }

    reorderSchemaRow(fromIndex, toIndex);
  }

  function onSchemaRowDragEnd() {
    schemaRowDrag = null;
    document
      .querySelectorAll(
        'tr.schema-row.is-dragging, tr.schema-row.is-drop-target, tr.details-row.is-dragging, tr.details-row.is-drop-target',
      )
      .forEach((el) => {
        el.classList.remove('is-dragging', 'is-drop-target');
      });
  }

  function reorderSchemaRow(fromIndex: number, toIndex: number) {
    if (fromIndex < 0 || fromIndex >= schemaRows.length || toIndex < 0 || toIndex >= schemaRows.length) {
      return;
    }

    const openKeys = collectOpenAdvancedKeys();
    const moved = schemaRows.splice(fromIndex, 1)[0];

    schemaRows.splice(toIndex, 0, moved);
    setDirty(true);
    render();
    restoreOpenAdvancedKeys(openKeys);
  }

  async function saveSchema() {
    if (!schemaState) {
      showBanner('error', 'Cannot save the schema until it has loaded successfully.');

      return;
    }

    let raw: string;
    const beforeText = jsonBaseline.schema;

    if (rawMode) {
      raw = byId<HTMLTextAreaElement>('raw-editor')!.value;
    } else {
      const invalidAdditionalOptionsIndex = schemaRows.findIndex((row) => invalidAdditionalOptionsRows.has(row));

      if (invalidAdditionalOptionsIndex !== -1) {
        const tagName = schemaRows[invalidAdditionalOptionsIndex].name || 'row ' + (invalidAdditionalOptionsIndex + 1);

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

    showJsonDiffModal(beforeText, raw, () => void commitSchemaSave(raw).catch(showSaveError));
  }

  // Every way a save can fail ends in a visible error: a lost save must never look like a pending
  // one. The banner leaves the tab as it is (preserveContent), so the unsaved edits, raw JSON drafts
  // included, stay on screen and the tab stays dirty.
  function showSaveError(e: unknown) {
    showBanner('error', 'Save failed: ' + escapeHtml((e instanceof Error && e.message) || String(e)), true);
  }

  // PUTs a save and resolves to the server's JSON answer, or shows why the save failed and resolves
  // to null. A response that isn't JSON (Express' HTML error page, a proxy in between) counts as a
  // failure too, also with a 2xx status.
  async function putSave<T extends object>(url: string, body: unknown): Promise<T | null> {
    let r: Response;

    try {
      r = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      showSaveError(e);

      return null;
    }

    const data = (await r.json().catch(() => null)) as (T & ErrorBody) | null;

    if (r.ok && data && typeof data === 'object') {
      return data;
    }

    let message =
      (data && data.error) ||
      (r.ok
        ? 'the dev server sent an answer that is not JSON'
        : 'the dev server answered HTTP ' + r.status + (r.statusText ? ' ' + r.statusText : ''));

    if (data && data.details) {
      message += ' ' + data.details;
    }

    showSaveError(new Error(message));

    return null;
  }

  async function commitSchemaSave(raw: string) {
    const saveEditSeq = editSeq;
    const data = await putSave<SchemaSaveResponse>('/@api/variables/schema', { raw });

    if (!data) {
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
  function onComboFocus(i: number) {
    const list = byId('combo-list-' + i);

    if (list) {
      list.style.display = '';
    }
  }

  function onComboBlur(i: number) {
    // mousedown+preventDefault() on options already stops most blurs from firing before a pick
    // registers; this is just a safety net for focus leaving for any other reason (e.g. Tab).
    setTimeout(() => {
      const list = byId('combo-list-' + i);

      if (list) {
        list.style.display = 'none';
      }
    }, 150);
  }

  function onComboFilter(i: number, text: string) {
    const list = byId('combo-list-' + i);

    if (!list) {
      return;
    }

    const needle = text.toLowerCase();

    (Array.from(list.children) as HTMLElement[]).forEach((opt) => {
      const hay = (opt.dataset.id + ' ' + opt.dataset.text).toLowerCase();

      opt.style.display = hay.indexOf(needle) === -1 ? 'none' : '';
    });
  }

  function onSingleComboInput(i: number, text: string) {
    onComboFilter(i, text);
    updateValueField(i, text);
  }

  function onComboOptionPick(optEl: HTMLElement) {
    const list = optEl.closest<HTMLElement>('.ve-combo-list')!;
    const i = Number(list.id.replace('combo-list-', ''));
    const id = optEl.dataset.id as string;
    const text = optEl.dataset.text || id;
    const combo = optEl.closest('.ve-combo')!;
    const chipsEl = combo.querySelector<HTMLElement>('.ve-combo-chips');
    const inputEl = combo.querySelector<HTMLInputElement>('.ve-combo-input')!;

    if (chipsEl) {
      const already = (Array.from(chipsEl.children) as HTMLElement[]).some((c) => c.dataset.id === id);

      if (!already) {
        chipsEl.insertAdjacentHTML('beforeend', chipHtml(id, text));
      }

      inputEl.value = '';
      onComboFilter(i, '');
      commitMultiValue(i, chipsEl);
    } else {
      inputEl.value = id;
      updateValueField(i, id);
      list.style.display = 'none';
    }
  }

  function onChipRemove(btn: HTMLElement) {
    const chip = btn.closest('.ve-chip')!;
    const chipsEl = chip.parentElement!;
    const i = Number(chipsEl.dataset.row);

    chip.remove();
    commitMultiValue(i, chipsEl);
  }

  function commitMultiValue(i: number, chipsEl: HTMLElement) {
    const ids = (Array.from(chipsEl.children) as HTMLElement[]).map((c) => c.dataset.id);

    updateValueField(i, ids.join(','));
  }

  function onListItemSelectChange(i: number, itemIndex: number, fieldName: string, selectEl: HTMLSelectElement) {
    const value = selectEl.multiple
      ? Array.from(selectEl.selectedOptions)
          .map((o) => o.value)
          .join(',')
      : selectEl.value;

    updateListItemField(i, itemIndex, fieldName, value);
  }

  // `fieldName` is the item's column, `null` for an item of a flat list of strings.
  function updateListItemField(i: number, itemIndex: number, fieldName: string | null, value: string) {
    const items = parseListItems(valueRows[i]) || [];

    if (fieldName === null) {
      items[itemIndex] = value;
    } else {
      if (typeof items[itemIndex] !== 'object' || items[itemIndex] === null || Array.isArray(items[itemIndex])) {
        items[itemIndex] = {};
      }

      (items[itemIndex] as Record<string, unknown>)[fieldName] = value;
    }

    valueRows[i].value = JSON.stringify(items);
    setDirty(true);
  }

  function addListItem(i: number) {
    const items = parseListItems(valueRows[i]) || [];
    const config = listConfigFor(schemaTagFor(valuesState, valueRows[i].name));

    if (config) {
      const newItem: Record<string, string> = {};

      config.forEach((col) => {
        newItem[String(col.name)] = '';
      });
      items.push(newItem);
    } else {
      items.push('');
    }

    valueRows[i].value = JSON.stringify(items);
    selectedValueIndex = i;
    setDirty(true);
    render();
  }

  function removeListItem(i: number, itemIndex: number) {
    const items = parseListItems(valueRows[i]) || [];

    items.splice(itemIndex, 1);
    valueRows[i].value = JSON.stringify(items);
    selectedValueIndex = i;
    setDirty(true);
    render();
  }

  let listItemDrag: { valueIndex: number; fromIndex: number } | null = null;

  function onListItemDragStart(ev: DragEvent) {
    const item = (ev.target as Element).closest<HTMLElement>('.ve-values-list-item');

    if (!item) {
      return;
    }

    listItemDrag = {
      valueIndex: Number(item.dataset.valueIndex),
      fromIndex: Number(item.dataset.itemIndex),
    };
    item.classList.add('is-dragging');
    ev.dataTransfer!.effectAllowed = 'move';
    // Firefox requires setData for the drag to start.
    ev.dataTransfer!.setData('text/plain', String(listItemDrag.fromIndex));
  }

  function onListItemDragOver(ev: DragEvent, item: HTMLElement) {
    if (!listItemDrag) {
      return;
    }

    if (Number(item.dataset.valueIndex) !== listItemDrag.valueIndex) {
      return;
    }

    ev.preventDefault();
    ev.dataTransfer!.dropEffect = 'move';
    item.classList.add('is-drop-target');
  }

  function onListItemDragLeave(ev: DragEvent, item: HTMLElement) {
    // Ignore leave events that stay inside the same item card (child elements).
    if (item.contains(ev.relatedTarget as Node | null)) {
      return;
    }

    item.classList.remove('is-drop-target');
  }

  function onListItemDrop(ev: DragEvent, item: HTMLElement) {
    ev.preventDefault();

    item.classList.remove('is-drop-target');

    if (!listItemDrag || Number(item.dataset.valueIndex) !== listItemDrag.valueIndex) {
      return;
    }

    const toIndex = Number(item.dataset.itemIndex);
    const fromIndex = listItemDrag.fromIndex;

    listItemDrag = null;

    if (fromIndex === toIndex) {
      return;
    }

    reorderListItem(Number(item.dataset.valueIndex), fromIndex, toIndex);
  }

  function onListItemDragEnd() {
    listItemDrag = null;
    document.querySelectorAll('.ve-values-list-item.is-dragging, .ve-values-list-item.is-drop-target').forEach((el) => {
      el.classList.remove('is-dragging', 'is-drop-target');
    });
  }

  function reorderListItem(i: number, fromIndex: number, toIndex: number) {
    const items = parseListItems(valueRows[i]) || [];

    if (fromIndex < 0 || fromIndex >= items.length || toIndex < 0 || toIndex >= items.length) {
      return;
    }

    const moved = items.splice(fromIndex, 1)[0];

    items.splice(toIndex, 0, moved);
    valueRows[i].value = JSON.stringify(items);
    selectedValueIndex = i;
    setDirty(true);
    render();
  }

  function refreshValuesJsonIssues() {
    const editorEl = byId<HTMLTextAreaElement>('values-raw-editor');
    const issuesEl = byId('values-raw-issues');

    if (!editorEl || !issuesEl) {
      return;
    }

    issuesEl.innerHTML = renderJsonIssuesBar(editorEl.value, valuesState);
  }

  let valuesRawIssuesTimer: ReturnType<typeof setTimeout> | null = null;

  function onValuesRawInput() {
    setDirty(true);

    if (valuesRawIssuesTimer) {
      clearTimeout(valuesRawIssuesTimer);
    }

    valuesRawIssuesTimer = setTimeout(refreshValuesJsonIssues, 300);
  }

  function downloadValuesJson() {
    const editorEl = byId<HTMLTextAreaElement>('values-raw-editor');
    const text = editorEl ? editorEl.value : JSON.stringify(toExportableValueRows(valueRows, valuesState), null, 2);
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
    byId('import-values-file')!.click();
  }

  function onImportValuesFile(inputEl: HTMLInputElement) {
    const file = inputEl.files?.[0];

    if (!file) {
      return;
    }

    const reader = new FileReader();

    reader.onload = () => {
      const editorEl = byId<HTMLTextAreaElement>('values-raw-editor');

      if (editorEl) {
        editorEl.value = String(reader.result || '');
        setDirty(true);
        refreshValuesJsonIssues();
      }
    };

    reader.readAsText(file);
    inputEl.value = '';
  }

  function updateValueNavActive(i: number) {
    document
      .querySelectorAll<HTMLElement>('.ve-values-nav-list .ve-values-nav-item[data-value-index]')
      .forEach((el) => {
        const active = Number(el.dataset.valueIndex) === i;

        el.classList.toggle('is-active', active);

        if (active) {
          el.scrollIntoView({ block: 'nearest' });
        }
      });
    document.querySelectorAll<HTMLElement>('.ve-values-anchor[data-value-index]').forEach((el) => {
      el.classList.toggle('is-active', Number(el.dataset.valueIndex) === i);
    });
  }

  function scrollToValueRow(i: number, smooth: boolean) {
    const detail = document.querySelector<HTMLElement>('.ve-values-detail');
    const target = byId('value-item-' + i);

    if (!detail || !target || typeof detail.scrollTo !== 'function') {
      return;
    }

    const top = target.getBoundingClientRect().top - detail.getBoundingClientRect().top + detail.scrollTop;

    detail.scrollTo({ top: Math.max(0, top - 8), behavior: smooth ? 'smooth' : 'auto' });
  }

  let valueNavScrollLock = false;
  let valueNavScrollLockTimer: ReturnType<typeof setTimeout> | null = null;

  function selectValueRow(i: number) {
    selectedValueIndex = i;
    updateValueNavActive(i);
    valueNavScrollLock = true;

    if (valueNavScrollLockTimer) {
      clearTimeout(valueNavScrollLockTimer);
    }

    scrollToValueRow(i, true);
    valueNavScrollLockTimer = setTimeout(function () {
      valueNavScrollLock = false;
      valueNavScrollLockTimer = null;
    }, 500);
  }

  function syncValueNavFromScroll() {
    if (valueNavScrollLock) {
      return;
    }

    const detail = document.querySelector<HTMLElement>('.ve-values-detail');

    if (!detail) {
      return;
    }

    const anchors = detail.querySelectorAll<HTMLElement>('.ve-values-anchor[data-value-index]');

    if (!anchors.length) {
      return;
    }

    const nearBottom = detail.scrollTop + detail.clientHeight >= detail.scrollHeight - 4;
    let current: number;

    if (nearBottom) {
      current = Number(anchors[anchors.length - 1].dataset.valueIndex);
    } else {
      const threshold = detail.getBoundingClientRect().top + 24;

      current = Number(anchors[0].dataset.valueIndex) || 0;
      anchors.forEach(function (el) {
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
    const detail = document.querySelector<HTMLElement>('.ve-values-detail');

    if (!detail || detail.dataset.scrollBound === '1') {
      return;
    }

    detail.dataset.scrollBound = '1';
    detail.addEventListener('scroll', syncValueNavFromScroll, { passive: true });
  }

  function renderValuesTab(): string {
    if (valuesState && !valuesRawMode && valueRows.length) {
      if (selectedValueIndex < 0 || selectedValueIndex >= valueRows.length) {
        selectedValueIndex = 0;
      }
    }

    return renderValuesTabHtml(valuesState, valueRows, valuesRawMode, selectedValueIndex);
  }

  function toggleValuesRawMode() {
    if (valuesRawMode) {
      // Leaving raw mode: try to parse back into rows; keep raw mode on failure. The value field
      // may be a native JSON array (list-type) as well as a plain string — see toExportableValueRows().
      const editorEl = byId<HTMLTextAreaElement>('values-raw-editor');
      const editorText = editorEl ? editorEl.value : JSON.stringify(toExportableValueRows(valueRows, valuesState));

      try {
        const parsed: unknown = JSON.parse(editorText);

        if (
          !Array.isArray(parsed) ||
          (parsed as unknown[]).some((e) => {
            const entry = e as Partial<ExportableValueRow> | null;

            return (
              typeof entry !== 'object' ||
              entry === null ||
              typeof entry.name !== 'string' ||
              entry.value === undefined ||
              entry.value === null
            );
          })
        ) {
          throw new Error('Must be an array of { name, value } entries with non-empty names and a defined value.');
        }

        valueRows = fromExportableValueRows(parsed as ExportableValueRow[]);
      } catch (e) {
        // showBanner() re-renders, which would otherwise regenerate this textarea from the last
        // known-good valueRows — put the user's (still-broken) text back afterward so their
        // in-progress edit isn't silently discarded.
        showBanner('error', 'Cannot switch to table view: ' + escapeHtml(errorMessage(e)));

        const freshEditorEl = byId<HTMLTextAreaElement>('values-raw-editor');

        if (freshEditorEl) {
          freshEditorEl.value = editorText;
        }

        return;
      }
    }

    valuesRawMode = !valuesRawMode;
    setUrlState(activeTab, valuesRawMode);
    render();
  }

  function updateValueField(i: number, value: string) {
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
      if (ev.target === overlay) {
        closeImportModal();
      }
    });
    overlay.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeImportModal();
      }
    });

    document.body.appendChild(overlay);
    void renderImportPickerStep(overlay);
  }

  function closeImportModal() {
    const overlay = byId('ve-import-overlay');

    if (overlay) {
      overlay.remove();
    }
  }

  function backToImportPicker() {
    const overlay = byId('ve-import-overlay');

    if (overlay) {
      void renderImportPickerStep(overlay);
    }
  }

  async function renderImportPickerStep(overlay: HTMLElement) {
    overlay.innerHTML = importPickerStepHtml();

    let r: Response;

    try {
      r = await fetch('/@api/variables/pages');
    } catch (e) {
      setImportBodyError(overlay, errorMessage(e));

      return;
    }

    const data = (await r.json().catch(() => ({}))) as PagesResponse;

    if (!overlay.isConnected) {
      return;
    }

    if (!r.ok) {
      setImportBodyError(overlay, data.error || 'Failed to load the page list.');

      return;
    }

    const bodyEl = overlay.querySelector('.ve-modal-body');

    if (!bodyEl) {
      return;
    }

    bodyEl.innerHTML = importPickerBodyHtml(data.pages || []);

    const filterEl = byId('ve-import-filter');

    if (filterEl) {
      filterEl.focus();
    }
  }

  function setImportBodyError(overlay: HTMLElement, message: string) {
    if (!overlay.isConnected) {
      return;
    }

    const bodyEl = overlay.querySelector('.ve-modal-body');

    if (bodyEl) {
      bodyEl.innerHTML = importErrorHtml(message);
    }
  }

  function filterImportPages(text: string) {
    const needle = text.trim().toLowerCase();
    let visible = 0;

    document.querySelectorAll<HTMLElement>('.ve-import-page-row').forEach(function (row) {
      const match = !needle || (row.dataset.search as string).indexOf(needle) !== -1;

      row.style.display = match ? '' : 'none';

      if (match) {
        visible++;
      }
    });

    document.querySelectorAll<HTMLElement>('.ve-import-page-group').forEach(function (group) {
      const anyVisible = Array.from(group.querySelectorAll<HTMLElement>('.ve-import-page-row')).some(function (row) {
        return row.style.display !== 'none';
      });

      group.style.display = anyVisible ? '' : 'none';
    });

    const emptyEl = byId('ve-import-page-empty');

    if (emptyEl) {
      emptyEl.style.display = visible === 0 ? '' : 'none';
    }
  }

  async function selectImportSourcePage(pageId: string, pageName: string) {
    const overlay = byId('ve-import-overlay');

    if (!overlay) {
      return;
    }

    overlay.dataset.sourcePageId = String(pageId);
    overlay.innerHTML = importReviewStepHtml(pageName);

    let r: Response;

    try {
      r = await fetch('/@api/variables/import-plan/' + pageId);
    } catch (e) {
      setImportBodyError(overlay, errorMessage(e));

      return;
    }

    const data = (await r.json().catch(() => ({}))) as ImportPlan;

    // A newer pick (or Back) landed before this one resolved — drop the stale response.
    if (!overlay.isConnected || overlay.dataset.sourcePageId !== String(pageId)) {
      return;
    }

    if (!r.ok) {
      setImportBodyError(overlay, data.error || 'Failed to load values from this page.');

      return;
    }

    const bodyEl = overlay.querySelector('.ve-modal-body');
    const actionsEl = overlay.querySelector('#ve-import-actions');

    if (!bodyEl || !actionsEl) {
      return;
    }

    importReviewCandidates = data.importable || [];
    importReviewPageName = pageName;

    bodyEl.innerHTML = importReviewBodyHtml(data);
    actionsEl.innerHTML = importReviewActionsHtml(data);

    const applyBtn = byId('ve-import-apply-btn');

    if (applyBtn) {
      applyBtn.focus();
    }
  }

  function toggleImportAll(checked: boolean) {
    document.querySelectorAll<HTMLInputElement>('.ve-import-check').forEach(function (c) {
      c.checked = checked;
    });
    updateImportCount();
  }

  function updateImportCount() {
    const checks = document.querySelectorAll('.ve-import-check');
    const checkedCount = document.querySelectorAll('.ve-import-check:checked').length;
    const countEl = byId('ve-import-count');
    const selectAllEl = byId<HTMLInputElement>('ve-import-select-all');
    const applyBtn = byId<HTMLButtonElement>('ve-import-apply-btn');

    if (countEl) {
      countEl.textContent = checkedCount + ' of ' + checks.length + ' selected';
    }

    if (selectAllEl) {
      selectAllEl.checked = checkedCount === checks.length;
    }

    if (applyBtn) {
      applyBtn.textContent = 'Apply ' + checkedCount + ' selected';
      applyBtn.disabled = checkedCount === 0;
    }
  }

  function applyImportPlan() {
    const checkedIndexes = Array.from(document.querySelectorAll<HTMLInputElement>('.ve-import-check:checked')).map(
      function (c) {
        return Number(c.dataset.index);
      },
    );

    let applied = 0;

    checkedIndexes.forEach((idx) => {
      const candidate = importReviewCandidates[idx];

      if (!candidate) {
        return;
      }

      const row = valueRows.find((r) => r.name === candidate.name);

      if (!row) {
        return;
      }

      row.value = candidate.sourceValue;
      applied++;
    });

    const total = importReviewCandidates.length;
    const pageName = importReviewPageName;

    closeImportModal();

    if (!applied) {
      return;
    }

    setDirty(true);
    showBanner(
      'success',
      'Imported ' + applied + ' of ' + total + ' variable(s) from "' + escapeHtml(pageName) + '". Save to apply.',
    );
  }

  function addValueRow() {
    showCustomValueModal('Variable name', '', (name) => {
      if (!name) {
        return;
      }

      valueRows.push({ name, value: '' });
      selectedValueIndex = valueRows.length - 1;
      setDirty(true);
      render();
    });
  }

  function removeValueRow(i: number) {
    const name = (valueRows[i] && valueRows[i].name) || '(unnamed)';

    showConfirmModal('Delete variable "' + name + '"? This only takes effect once you Save.', () => {
      valueRows.splice(i, 1);
      selectedValueIndex = Math.min(i, Math.max(0, valueRows.length - 1));
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
        tags = fromExportableValueRows(
          JSON.parse(byId<HTMLTextAreaElement>('values-raw-editor')!.value) as ExportableValueRow[],
        );
      } catch (e) {
        showBanner('error', 'Raw JSON is not valid: ' + escapeHtml(errorMessage(e)));

        return;
      }
    }

    const afterText = snapshotValuesJson(tags);

    if (normalizeJsonText(beforeText) === normalizeJsonText(afterText)) {
      setDirty(false);
      showBanner('success', 'No JSON changes to save.');

      return;
    }

    showJsonDiffModal(beforeText, afterText, () => void commitValuesSave(tags, afterText).catch(showSaveError));
  }

  async function commitValuesSave(tags: ValueRow[], afterText: string) {
    const saveEditSeq = editSeq;
    const data = await putSave<ValuesSaveResponse>('/@api/variables/values', { tags });

    if (!data) {
      return;
    }

    const warnings = data.warnings || [];
    const hasNewerEdits = editSeq !== saveEditSeq;
    // The local pages are updated with the save; if that failed, the floating button offers it again.
    const localNote = data.localError
      ? '<div>The local pages still show the old values: ' +
        escapeHtml(data.localError) +
        '. Use <b>Update local pages</b>.</div>'
      : '';
    const message =
      (warnings.length
        ? 'Saved, with warning(s):<ul>' +
          warnings.map((w) => '<li>' + escapeHtml(w.message) + '</li>').join('') +
          '</ul>'
        : 'Values saved.') + localNote;

    // MI holds the saved values now, and the local pages what the save updated them to: compare
    // those, also when newer edits keep the tab from reloading below.
    if (valuesState) {
      valuesState.live = tags.map((t) => ({ name: t.name, value: t.value }));

      if (data.local !== undefined) {
        valuesState.local = data.local;
      }
    }

    renderLocalUpdateButton();

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
    (activeTab === 'schema' ? saveSchema() : saveValues()).catch(showSaveError);
  }

  // ── Local pages ──────────────────────────────────────────────────────────────
  // The dev server substitutes page variables into the pages it serves (to every user) from its own
  // copy, loaded from MI with the page data. A save updates it; a change made in MI itself doesn't,
  // so the Values tab compares that copy with MI and offers to update it.
  function localDifferences(): { name: string; local: string | undefined; live: string | undefined }[] {
    if (!valuesState || !Array.isArray(valuesState.local) || !Array.isArray(valuesState.live)) {
      return [];
    }

    // A missing variable differs from an empty one: the page keeps a missing one's [VarName] as is,
    // and drops an empty one's.
    const local = new Map(valuesState.local.map((e) => [e.name, String(e.value ?? '')]));
    const live = new Map(valuesState.live.map((e) => [e.name, String(e.value ?? '')]));
    const names = Array.from(new Set([...local.keys(), ...live.keys()]));

    return names
      .filter((name) => local.get(name) !== live.get(name))
      .map((name) => ({ name, local: local.get(name), live: live.get(name) }));
  }

  function shortValue(value: string | undefined): string {
    if (value === undefined) {
      return '(missing)';
    }

    if (!value) {
      return '(empty)';
    }

    return value.length > 40 ? value.slice(0, 40) + '…' : value;
  }

  function renderLocalUpdateButton() {
    const btn = byId<HTMLButtonElement>('local-update-btn');

    if (!btn) {
      return;
    }

    const diffs = activeTab === 'values' ? localDifferences() : [];

    btn.hidden = diffs.length === 0;

    if (!diffs.length) {
      return;
    }

    const lineBreak = String.fromCharCode(10);

    btn.textContent = 'Update local pages · ' + diffs.length;
    btn.title = ['The local dev server still shows older values (local → MI):']
      .concat(diffs.map((d) => d.name + ': ' + shortValue(d.local) + ' → ' + shortValue(d.live)))
      .join(lineBreak);
  }

  async function updateLocalValues() {
    const btn = byId<HTMLButtonElement>('local-update-btn')!;

    btn.disabled = true;

    try {
      const r = await fetch('/@api/variables/values/local', { method: 'POST' });
      const data = (await r.json().catch(() => ({}))) as LocalValuesResponse;

      // The banners leave the tab as it is (preserveContent): an unsaved draft, raw JSON included,
      // must survive updating the local pages.
      if (!r.ok) {
        showBanner(
          'error',
          escapeHtml(data.error || 'Failed to update the local values.') +
            (data.details ? ' ' + escapeHtml(data.details) : ''),
          true,
        );

        return;
      }

      if (valuesState) {
        // Just reloaded from MI: they are MI's latest values too, as far as the comparison goes.
        valuesState.local = data.local;
        valuesState.live = data.local as ValuesState['live'];
      }

      showBanner('success', 'Local pages updated: every tab shows the new values once reloaded.', true);
    } catch (e) {
      showBanner('error', 'Failed to update the local values: ' + escapeHtml(errorMessage(e)), true);
    } finally {
      btn.disabled = false;
      renderLocalUpdateButton();
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  function render() {
    const bannerHtml = banner ? '<div class="banner banner-' + banner.type + '">' + banner.html + '</div>' : '';

    contentEl.innerHTML =
      bannerHtml + (activeTab === 'schema' ? renderSchemaTabHtml(schemaState, rawMode, schemaRows) : renderValuesTab());
    autosizeAllCellTextareas();
    renderLocalUpdateButton();

    if (activeTab === 'values' && !valuesRawMode) {
      bindValuesDetailScroll();
      scrollToValueRow(selectedValueIndex, false);
    }

    if (activeTab === 'values' && valuesRawMode) {
      refreshValuesJsonIssues();
    }

    const loadingEl = byId('loading-indicator');

    if (loadingEl) {
      // Only surface the indicator when there's cached content already on screen underneath it —
      // when there isn't (state is still null), renderSkeleton() above is the loading signal.
      const stateForTab = activeTab === 'schema' ? schemaState : valuesState;
      const isLoading = activeTab === 'schema' ? schemaLoading : valuesLoading;

      loadingEl.style.display = isLoading && stateForTab ? '' : 'none';
    }
  }

  // ── Events ───────────────────────────────────────────────────────────────────
  // One listener per event type for the whole page — the toolbar, the tab's content and the
  // import dialog. Controls carry `data-action` and what it acts on: `data-index` (the variable's
  // row), `data-col` (a list column), `data-item` (a list item), `data-column` (a list item's
  // field, none for a flat list), `data-field`; `data-autosize` on a textarea/select also resizes
  // it to its content. Drag handles carry `data-drag`, drop targets `data-drop`.
  const actionTarget = (event: Event) =>
    event.target instanceof Element ? event.target.closest<HTMLElement>('[data-action]') : null;
  const index = (el: HTMLElement) => Number(el.dataset.index);
  const col = (el: HTMLElement) => Number(el.dataset.col);
  const item = (el: HTMLElement) => Number(el.dataset.item);
  const field = <T extends string>(el: HTMLElement) => el.dataset.field as T;
  const checked = (el: HTMLElement) => (el as HTMLInputElement).checked;

  const clickActions: Record<string, (el: HTMLElement) => void> = {
    'switch-tab': (el) => switchTab(el.dataset.tab as Tab),
    refresh: () => refresh(),
    save: () => save(),
    'update-local-values': () => void updateLocalValues(),
    'toggle-raw-mode': () => toggleRawMode(),
    'add-schema-row': () => addSchemaRow(),
    'toggle-schema-advanced': (el) => toggleSchemaAdvanced(index(el)),
    'remove-schema-row': (el) => removeSchemaRow(index(el)),
    'show-additional-options-help': (el) => showAdditionalOptionsHelp(index(el)),
    'show-list-columns-help': () => showInfoModal('additional_options — list', LIST_COLUMNS_HELP_HTML),
    'add-list-column': (el) => addListColumn(index(el)),
    'remove-list-column': (el) => removeListColumn(index(el), col(el)),
    'toggle-values-raw-mode': () => toggleValuesRawMode(),
    'download-values-json': () => downloadValuesJson(),
    'import-values-json': () => triggerImportValuesJson(),
    'open-import-modal': () => openImportValuesModal(),
    'add-value-row': () => addValueRow(),
    'select-value-row': (el) => selectValueRow(Number(el.dataset.valueIndex)),
    'remove-value-row': (el) => removeValueRow(index(el)),
    'remove-chip': (el) => onChipRemove(el),
    'add-list-item': (el) => addListItem(index(el)),
    'remove-list-item': (el) => removeListItem(index(el), item(el)),
    'close-import-modal': () => closeImportModal(),
    'back-to-import-picker': () => backToImportPicker(),
    'select-import-page': (el) => void selectImportSourcePage(el.dataset.pageId!, el.dataset.pageName!),
    'apply-import-plan': () => applyImportPlan(),
  };

  const inputActions: Record<string, (el: FieldElement) => void> = {
    'set-dirty': () => setDirty(true),
    'schema-field': (el) => updateSchemaField(index(el), field<SchemaTextField>(el), el.value),
    'schema-additional-options': (el) => updateSchemaAdditionalOptions(index(el), el.value),
    'list-column-name': (el) => updateListColumnField(index(el), col(el), 'name', el.value),
    'list-column-options': (el) => updateListColumnOptions(index(el), col(el), el.value),
    value: (el) => updateValueField(index(el), el.value),
    'values-raw-input': () => onValuesRawInput(),
    'combo-filter': (el) => onComboFilter(index(el), el.value),
    'single-combo': (el) => onSingleComboInput(index(el), el.value),
    'list-item-field': (el) => updateListItemField(index(el), item(el), el.dataset.column ?? null, el.value),
    'filter-import-pages': (el) => filterImportPages(el.value),
  };

  const changeActions: Record<string, (el: FieldElement) => void> = {
    'custom-select': (el) => onCustomSelectChange(index(el), el as HTMLSelectElement, field<SchemaChoiceField>(el)),
    'editor-flag': (el) => updateEditorFlag(index(el), field<EditorFlagField>(el), checked(el)),
    'list-column-field': (el) => updateListColumnField(index(el), col(el), field<'type' | 'source'>(el), el.value),
    'value-boolean': (el) => updateValueField(index(el), checked(el) ? 'true' : 'false'),
    'list-item-select': (el) =>
      onListItemSelectChange(index(el), item(el), el.dataset.column!, el as HTMLSelectElement),
    'import-values-file': (el) => onImportValuesFile(el as HTMLInputElement),
    'toggle-import-all': (el) => toggleImportAll(checked(el)),
    'update-import-count': () => updateImportCount(),
  };

  const onClick = (event: MouseEvent) => {
    const el = actionTarget(event);

    if (el) {
      clickActions[el.dataset.action!]?.(el);
    }
  };

  // Input and change each run only their own actions: a select also fires `input`, a textarea
  // `change` on blur, and those aren't what their handlers listen to.
  const onFieldEvent = (actions: Record<string, (el: FieldElement) => void>) => (event: Event) => {
    const el = actionTarget(event) as FieldElement | null;
    const handler = el && actions[el.dataset.action!];

    if (!el || !handler) {
      return;
    }

    if (el.dataset.autosize !== undefined) {
      autosizeCellTextarea(el);
    }

    handler(el);
  };

  // A combobox option is picked, and a chip's ✕ pressed, on mousedown with its default prevented:
  // the combobox's input keeps the focus, so its list doesn't close (blur) before the pick lands.
  const onMouseDown = (event: MouseEvent) => {
    const el = actionTarget(event);

    if (el?.dataset.action === 'pick-combo-option') {
      event.preventDefault();
      onComboOptionPick(el);
    } else if (el?.dataset.action === 'remove-chip') {
      event.preventDefault();
    }
  };

  // A combobox's option list shows while its input has the focus.
  const comboIndex = (event: FocusEvent) =>
    event.target instanceof HTMLElement && event.target.classList.contains('ve-combo-input')
      ? Number(event.target.dataset.index)
      : null;

  const onFocusIn = (event: FocusEvent) => {
    const i = comboIndex(event);

    if (i !== null) {
      onComboFocus(i);
    }
  };

  const onFocusOut = (event: FocusEvent) => {
    const i = comboIndex(event);

    if (i !== null) {
      onComboBlur(i);
    }
  };

  const dragHandlers: Record<string, { start: (ev: DragEvent) => void; end: () => void }> = {
    'schema-row': { start: onSchemaRowDragStart, end: onSchemaRowDragEnd },
    'list-column': { start: onListColumnDragStart, end: onListColumnDragEnd },
    'list-item': { start: onListItemDragStart, end: onListItemDragEnd },
  };

  type DropHandler = (ev: DragEvent, zone: HTMLElement) => void;

  const dropHandlers: Record<string, { over: DropHandler; leave: DropHandler; drop: DropHandler }> = {
    'schema-row': { over: onSchemaRowDragOver, leave: onSchemaRowDragLeave, drop: onSchemaRowDrop },
    'list-column': { over: onListColumnDragOver, leave: onListColumnDragLeave, drop: onListColumnDrop },
    'list-item': { over: onListItemDragOver, leave: onListItemDragLeave, drop: onListItemDrop },
  };

  const dragHandle = (event: DragEvent) =>
    event.target instanceof Element ? event.target.closest<HTMLElement>('[data-drag]') : null;

  const onDragStart = (event: DragEvent) => {
    const handle = dragHandle(event);

    if (handle) {
      dragHandlers[handle.dataset.drag!]?.start(event);
    }
  };

  const onDragEnd = (event: DragEvent) => {
    const handle = dragHandle(event);

    if (handle) {
      dragHandlers[handle.dataset.drag!]?.end();
    }
  };

  // Drop targets nest (a list column's card sits in a schema row's details row), and each has its
  // own handler: they all run, innermost first, as the event bubbles through them. The targets are
  // collected first — a drop re-renders the tab, as when each element had its own listener.
  const onDropZoneEvent = (kind: 'over' | 'leave' | 'drop') => (event: DragEvent) => {
    const zones: HTMLElement[] = [];
    let zone = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-drop]') : null;

    while (zone) {
      zones.push(zone);
      zone = zone.parentElement?.closest<HTMLElement>('[data-drop]') ?? null;
    }

    for (const target of zones) {
      dropHandlers[target.dataset.drop!]?.[kind](event, target);
    }
  };

  const listeners: { [K in keyof DocumentEventMap]?: (event: DocumentEventMap[K]) => void } = {
    click: onClick,
    input: onFieldEvent(inputActions),
    change: onFieldEvent(changeActions),
    mousedown: onMouseDown,
    focusin: onFocusIn,
    focusout: onFocusOut,
    dragstart: onDragStart,
    dragend: onDragEnd,
    dragover: onDropZoneEvent('over'),
    dragleave: onDropZoneEvent('leave'),
    drop: onDropZoneEvent('drop'),
  };

  for (const [type, listener] of Object.entries(listeners)) {
    document.addEventListener(type, listener as EventListener);
  }

  byId('tab-schema')!.classList.toggle('active', activeTab === 'schema');
  byId('tab-values')!.classList.toggle('active', activeTab === 'values');
  setUrlState(activeTab, valuesRawMode);

  // Skeleton first (nothing's cached yet on a fresh page load), then swap in the real content.
  render();
  void loadTabData(activeTab).then(render);

  return () => {
    window.removeEventListener('beforeunload', onBeforeUnload);
    document.removeEventListener('click', onThemeClick);

    for (const [type, listener] of Object.entries(listeners)) {
      document.removeEventListener(type, listener as EventListener);
    }

    if (autoLoadTimer) {
      clearTimeout(autoLoadTimer);
    }

    if (valuesRawIssuesTimer) {
      clearTimeout(valuesRawIssuesTimer);
    }
  };
}
