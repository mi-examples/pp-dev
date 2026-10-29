// The Values tab's HTML (a widget per variable, by its schema type) and its JSON mode's
// conversions. Controls say what they do in `data-action` (with `data-index`, `data-item`,
// `data-column`, …); editor.ts handles their events in one place.
import {
  actionAttrs,
  escapeHtml,
  normalizeOptionEntry,
  renderSkeleton,
  sourceBadgeHtml,
  typeBadgeHtml,
} from './html.js';
import { renderDescriptionMarkdown } from './markdown.js';
import type {
  ExportableValueRow,
  JsonIssue,
  ListColumn,
  NormalizedOption,
  OptionEntry,
  SchemaTag,
  ValueRow,
  ValuesState,
} from './types.js';

export function schemaTagFor(state: ValuesState | null, name: string): SchemaTag | undefined {
  const tags = (state?.schema && state.schema.tags) || [];

  return tags.find((t) => t.name === name);
}

// MI renders descriptions as markdown; the part of it that matters there (see
// markdown.ts), with everything else escaped.
function descriptionHint(tag: SchemaTag | undefined): string {
  if (!tag || !tag.description) {
    return '';
  }

  return '<div class="hint ve-md" style="margin-bottom: 8px;">' + renderDescriptionMarkdown(tag.description) + '</div>';
}

// The plain-text default already matches MI's own fallback (a multiline input); on top of
// that, mirror the three editor-flag checkboxes from the Schema tab's Advanced panel — MI's
// own value editor swaps in a rich/code editor for the first two (we use a plain textarea for
// both, since embedding a real WYSIWYG editor is out of scope for this lightweight tool). The
// third (use_json_editor_ind) is accepted by MI's create form but never actually acted upon by
// its value editor either — shown here only as an FYI, no widget change.
function textValueCell(tag: SchemaTag, row: ValueRow, i: number): string {
  const widget =
    '<textarea class="cell-textarea"' +
    actionAttrs('value', { index: i }) +
    ' data-autosize>' +
    escapeHtml(row.value) +
    '</textarea>';
  let note = '';

  if (tag.use_hmtl_editor_ind === 'Y') {
    note = 'WYSIWYG HTML in MI — edited as raw HTML here.';
  } else if (tag.use_raw_html_ind === 'Y') {
    note = 'Raw HTML — MI skips XSS-encoding this value on save.';
  } else if (tag.use_json_editor_ind === 'Y') {
    note = "JSON Editor flag is set, though MI's value editor doesn't actually act on it.";
  }

  return note ? widget + '<div class="hint">' + note + '</div>' : widget;
}

export function normalizeStaticOptions(tag: SchemaTag | undefined): NormalizedOption[] {
  const opts = tag && tag.additional_options;

  if (!Array.isArray(opts)) {
    return [];
  }

  return (opts as OptionEntry[]).map(normalizeOptionEntry);
}

function labelForOption(options: NormalizedOption[], id: string): string {
  const found = options.find((o) => o.id === id);

  return found ? found.text : id;
}

// The options of a combobox: picked on mousedown (see editor.ts), before the input loses focus.
function comboOptionsHtml(options: NormalizedOption[]): string {
  return options
    .map(
      (o) =>
        '<div class="ve-combo-option" data-id="' +
        escapeHtml(o.id) +
        '" data-text="' +
        escapeHtml(o.text) +
        '"' +
        actionAttrs('pick-combo-option') +
        '>' +
        (o.text !== o.id
          ? escapeHtml(o.text) + ' <span class="hint">(' + escapeHtml(o.id) + ')</span>'
          : escapeHtml(o.id)) +
        '</div>',
    )
    .join('');
}

export function chipHtml(id: string, text: string): string {
  return (
    '<span class="ve-chip" data-id="' +
    escapeHtml(id) +
    '">' +
    escapeHtml(text) +
    '<button type="button"' +
    actionAttrs('remove-chip') +
    '>✕</button></span>'
  );
}

// A search-as-you-type combobox — not a native <select>/<datalist> (see the Schema tab's
// tag_type picker for why: unstylable popups, broken selected-state colors). Only viable for
// tag_source "static", since that's the only source whose options live in additional_options
// itself; every other source needs MI's own internal editor-only options endpoint, which we
// deliberately don't call (no public API for it — see TEMPLATE_VARIABLES.md).
function selectValueWidget(tag: SchemaTag, row: ValueRow, i: number): string {
  const options = normalizeStaticOptions(tag);
  const isMulti = tag.tag_type === 'multiselect';

  if (isMulti) {
    const ids = row.value ? row.value.split(',').filter(Boolean) : [];
    const chips = ids.map((id) => chipHtml(id, labelForOption(options, id))).join('');

    return (
      '<div class="ve-combo ve-combo-multi">' +
      '<div class="ve-combo-chips" data-row="' +
      i +
      '" id="combo-chips-' +
      i +
      '">' +
      chips +
      '</div>' +
      '<input type="text" class="ve-combo-input" placeholder="Search by id or value…"' +
      actionAttrs('combo-filter', { index: i }) +
      ' />' +
      '<div class="ve-combo-list" id="combo-list-' +
      i +
      '" style="display:none">' +
      comboOptionsHtml(options) +
      '</div>' +
      '</div>'
    );
  }

  return (
    '<div class="ve-combo">' +
    '<input type="text" class="ve-combo-input" value="' +
    escapeHtml(row.value || '') +
    '" placeholder="Search by id or value…"' +
    actionAttrs('single-combo', { index: i }) +
    ' />' +
    '<div class="ve-combo-list" id="combo-list-' +
    i +
    '" style="display:none">' +
    comboOptionsHtml(options) +
    '</div>' +
    '</div>'
  );
}

// Non-empty additional_options (array) means column-defined objects; empty/absent means a flat
// list of strings. A bare string entry is shorthand for { name: <string>, type: 'textarea' }.
export function listConfigFor(tag: SchemaTag | undefined): ListColumn[] | null {
  const opts = tag && tag.additional_options;

  return Array.isArray(opts) && opts.length
    ? (opts as (string | ListColumn)[]).map((c) => (typeof c === 'string' ? { name: c, type: 'textarea' } : c))
    : null;
}

export function parseListItems(row: ValueRow): unknown[] | null {
  try {
    const parsed: unknown = row.value ? JSON.parse(row.value) : [];

    // A stored "null" (MI's own encoding for "no value yet") means an empty list, not invalid
    // JSON — only reject genuinely non-array, non-null JSON (e.g. an object or a number).
    if (parsed === null) {
      return [];
    }

    return Array.isArray(parsed) ? (parsed as unknown[]) : null;
  } catch {
    return null;
  }
}

function listFieldLabelHtml(colName: string, source: string): string {
  return (
    '<div class="ve-values-field-label"><span>' + escapeHtml(colName) + '</span>' + sourceBadgeHtml(source) + '</div>'
  );
}

function listValueWidget(tag: SchemaTag | undefined, row: ValueRow, i: number): string {
  const items = parseListItems(row);

  if (items === null) {
    return (
      '<div class="ve-values-field is-wide"><div class="ve-values-field-label"><span>value</span></div>' +
      '<textarea class="cell-textarea"' +
      actionAttrs('value', { index: i }) +
      ' data-autosize>' +
      escapeHtml(row.value) +
      '</textarea>' +
      '<div class="hint" style="color:var(--red)">Not a valid JSON array — edit as raw text above, or fix it via "View/edit raw JSON".</div></div>'
    );
  }

  const config = listConfigFor(tag);
  const itemsHtml = items
    .map((item, itemIndex) => {
      return (
        '<div class="ve-values-list-item" data-value-index="' +
        i +
        '" data-item-index="' +
        itemIndex +
        '" data-drop="list-item">' +
        '<span class="ve-values-list-item-handle" draggable="true" data-drag="list-item" title="Drag to reorder" aria-label="Drag to reorder" role="button" tabindex="0">⠿</span>' +
        listItemFieldsHtml(config, item, i, itemIndex) +
        '<button type="button" class="btn btn-sm ve-values-list-item-remove" title="Remove item" aria-label="Remove item"' +
        actionAttrs('remove-list-item', { index: i, item: itemIndex }) +
        '>✕</button>' +
        '</div>'
      );
    })
    .join('');

  return (
    '<div class="ve-values-list-items">' +
    (itemsHtml || '<div class="ve-values-empty">No items yet.</div>') +
    '</div>' +
    '<button type="button" class="ve-values-nav-item ve-values-nav-add" style="margin-top:12px;width:auto"' +
    actionAttrs('add-list-item', { index: i }) +
    '>+ Add item</button>'
  );
}

function listItemFieldsHtml(config: ListColumn[] | null, item: unknown, i: number, itemIndex: number): string {
  if (!config) {
    const val = typeof item === 'string' ? item : String(item != null ? item : '');

    return (
      '<div class="ve-values-fields"><div class="ve-values-field is-wide">' +
      '<textarea class="cell-textarea"' +
      actionAttrs('list-item-field', { index: i, item: itemIndex }) +
      ' data-autosize>' +
      escapeHtml(val) +
      '</textarea>' +
      '</div></div>'
    );
  }

  const fieldsHtml = config
    .map((col) => {
      const colName = String(col.name);
      const field = (action: string) => actionAttrs(action, { index: i, item: itemIndex, column: colName });
      const colType = col.type || 'textarea';
      const colSource = col.source ? col.source : colType === 'select' || colType === 'multi-select' ? 'static' : '';
      const rawVal = typeof item === 'object' && item !== null ? (item as Record<string, unknown>)[colName] : '';
      const val = rawVal != null ? String(rawVal) : '';
      const wide = colType === 'textarea' || colType === 'file' || val.length > 48 ? ' is-wide' : '';

      if (colType === 'color') {
        const safe = /^#[0-9a-fA-F]{3,8}$/.test(val) ? val : '#000000';

        return (
          '<div class="ve-values-field">' +
          listFieldLabelHtml(colName, colSource) +
          '<input type="color" value="' +
          safe +
          '"' +
          field('list-item-field') +
          ' /></div>'
        );
      }

      if (colType === 'select' || colType === 'multi-select') {
        const isMulti = colType === 'multi-select';

        // Only "static" ships its option list locally (col.options); every other source is
        // populated live by MI's own editor (see additionalOptionsDetails()) and pp-dev has no
        // API to fetch it here — fall back to free text, same as the tag-level select does.
        if (colSource !== 'static') {
          return (
            '<div class="ve-values-field">' +
            listFieldLabelHtml(colName, colSource) +
            '<input type="text" value="' +
            escapeHtml(val) +
            '"' +
            field('list-item-field') +
            ' placeholder="source: ' +
            escapeHtml(colSource) +
            ' — no local option list" /></div>'
          );
        }

        // Each entry may be a plain string or a { id, text } object (e.g. {"text":"Yes","id":"Y"}) —
        // normalize before use, or an object entry stringifies to "[object Object]" for both the
        // <option> value and its label.
        const opts = (Array.isArray(col.options) ? col.options : []).map(normalizeOptionEntry);
        const selected = isMulti ? val.split(',').filter(Boolean) : [val];
        const optionsHtml = opts
          .map(
            (o) =>
              '<option value="' +
              escapeHtml(o.id) +
              '"' +
              (selected.indexOf(o.id) !== -1 ? ' selected' : '') +
              '>' +
              escapeHtml(o.text) +
              '</option>',
          )
          .join('');

        return (
          '<div class="ve-values-field">' +
          listFieldLabelHtml(colName, colSource) +
          '<select ' +
          (isMulti ? 'multiple ' : '') +
          field('list-item-select').trim() +
          ' data-autosize>' +
          optionsHtml +
          '</select></div>'
        );
      }

      return (
        '<div class="ve-values-field' +
        wide +
        '">' +
        listFieldLabelHtml(colName, colSource) +
        '<textarea class="cell-textarea"' +
        field('list-item-field') +
        ' data-autosize>' +
        escapeHtml(val) +
        '</textarea></div>'
      );
    })
    .join('');

  return '<div class="ve-values-fields">' + fieldsHtml + '</div>';
}

function valueEditorCell(tag: SchemaTag | undefined, row: ValueRow, i: number): string {
  const type = tag ? tag.tag_type : null;
  const value = actionAttrs('value', { index: i });

  if (type === 'boolean') {
    // MI's own page-variable UI writes literal 'true'/'false' strings, not 'Y'/'N' — the
    // extra accepted values below are just legacy/lenient reads, not something we write.
    const checked = ['true', 'Y', '1'].includes(row.value);

    return (
      '<input type="checkbox" ' +
      (checked ? 'checked' : '') +
      ' ' +
      actionAttrs('value-boolean', { index: i }).trim() +
      ' />'
    );
  }

  if (type === 'color') {
    const safe = /^#[0-9a-fA-F]{3,8}$/.test(row.value) ? row.value : '#000000';

    return '<input type="color" value="' + safe + '"' + value + ' />';
  }

  if ((type === 'select' || type === 'multiselect') && tag) {
    const source = tag.tag_source || 'static';

    if (source === 'static') {
      return selectValueWidget(tag, row, i);
    }

    return (
      '<input type="text" value="' +
      escapeHtml(row.value) +
      '"' +
      value +
      ' placeholder="tag_source: ' +
      escapeHtml(source) +
      ' — no local option list" />'
    );
  }

  if (type === 'file') {
    // No public MI API exists for listing/uploading a page's individual file assets (only
    // whole-bundle zip download/upload, which doesn't fit a single value) — manual path only.
    // MI's own upload control restricts these to images: jpg/jpeg/png/gif/svg.
    return (
      '<input type="text" value="' +
      escapeHtml(row.value) +
      '"' +
      value +
      ' placeholder="Existing image filename (jpg/jpeg/png/gif/svg)" />'
    );
  }

  if (type === 'list') {
    return listValueWidget(tag, row, i);
  }

  if (type === 'text' && tag) {
    return textValueCell(tag, row, i);
  }

  return '<input type="text" value="' + escapeHtml(row.value) + '"' + value + ' />';
}

// Same convention as the old "Export variables…"/"Setup variables…" flow (now retired in
// favor of this JSON mode): a list-type value is shown/accepted as a native JSON array
// instead of a JSON-string-in-a-string, converting only at this display/parse boundary —
// the PUT /@api/variables/values endpoint itself always sees plain strings.
export function toExportableValueRows(rows: ValueRow[], state: ValuesState | null): ExportableValueRow[] {
  return rows.map((row) => {
    const tag = schemaTagFor(state, row.name);

    if (tag && tag.tag_type === 'list') {
      try {
        const parsed: unknown = JSON.parse(row.value);

        if (Array.isArray(parsed)) {
          return { name: row.name, value: parsed };
        }
      } catch {
        // not valid JSON — keep the raw string below
      }
    }

    return { name: row.name, value: row.value };
  });
}

export function fromExportableValueRows(entries: ExportableValueRow[]): ValueRow[] {
  return entries.map(({ name, value }) => ({
    name,
    value: typeof value === 'string' ? value : JSON.stringify(value),
  }));
}

// Cheap, best-effort lint pass over the JSON textarea's current text — no textarea-internal
// highlighting (native hover tooltips can't reach through an editable textarea sitting on top
// of an overlay), just a small badge per flagged entry with a native title attribute explanation.
function computeJsonIssues(text: string, state: ValuesState | null): JsonIssue[] {
  let entries: unknown;

  try {
    entries = JSON.parse(text);
  } catch {
    return [];
  }

  if (!Array.isArray(entries)) {
    return [];
  }

  const baseline = new Map(
    toExportableValueRows(state && state.combined ? state.combined : [], state).map((e) => [
      e.name,
      JSON.stringify(e.value),
    ]),
  );

  const issues: JsonIssue[] = [];

  (entries as (Partial<ExportableValueRow> | null)[]).forEach((entry) => {
    if (!entry || typeof entry.name !== 'string') {
      return;
    }

    const messages: string[] = [];
    const tag = schemaTagFor(state, entry.name);

    if (!tag) {
      messages.push('Not found in the current schema (__template_variables.json) — MI has no matching variable.');
    }

    if (
      tag &&
      (tag.tag_type === 'select' || tag.tag_type === 'multiselect') &&
      (tag.tag_source || 'static') === 'static'
    ) {
      const options = normalizeStaticOptions(tag);

      if (options.length && typeof entry.value === 'string') {
        const tokens =
          tag.tag_type === 'multiselect'
            ? entry.value
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean)
            : [entry.value].filter(Boolean);
        const unmatched = tokens.filter((t) => !options.some((o) => o.id === t || o.text === t));

        if (unmatched.length) {
          messages.push(
            'Value "' + unmatched.join(', ') + "\" doesn't match any option in this variable's static list.",
          );
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

export function renderJsonIssuesBar(text: string, state: ValuesState | null): string {
  const issues = computeJsonIssues(text, state);

  if (!issues.length) {
    return '';
  }

  return (
    '<div class="ve-json-issues">' +
    issues
      .map(
        (issue) =>
          '<span class="ve-json-issue-badge" title="' +
          escapeHtml(issue.message) +
          '">⚠ ' +
          escapeHtml(issue.name) +
          '</span>',
      )
      .join('') +
    '</div>'
  );
}

function valuesNavItemHtml(tag: SchemaTag | undefined, row: ValueRow, i: number, isActive: boolean): string {
  const type = tag ? tag.tag_type || 'text' : 'unknown';
  const showsSource = tag && (tag.tag_type === 'select' || tag.tag_type === 'multiselect' || tag.tag_type === 'list');
  const source = showsSource ? tag.tag_source || 'static' : '';

  return (
    '<button type="button" class="ve-values-nav-item' +
    (isActive ? ' is-active' : '') +
    '" data-value-index="' +
    i +
    '"' +
    actionAttrs('select-value-row') +
    '>' +
    '<span class="ve-values-nav-dot"></span>' +
    '<span class="ve-values-nav-label">' +
    escapeHtml(row.name || '(unnamed)') +
    '</span>' +
    '<span class="ve-values-nav-badges">' +
    typeBadgeHtml(type) +
    sourceBadgeHtml(source) +
    '</span>' +
    '</button>'
  );
}

function valuesDetailHtml(tag: SchemaTag | undefined, row: ValueRow, i: number): string {
  const type = tag ? tag.tag_type || 'text' : '';
  const source = tag && tag.tag_source ? tag.tag_source : '';
  const isList = type === 'list';

  const header =
    '<div class="ve-values-detail-header">' +
    '<div class="ve-values-detail-title">' +
    escapeHtml(row.name || '(unnamed)') +
    '</div>' +
    listFieldLabelHtml(type || 'value', source) +
    '<button type="button" class="btn btn-sm"' +
    actionAttrs('remove-value-row', { index: i }) +
    ' title="Delete variable">✕</button>' +
    '</div>';

  if (isList) {
    return header + descriptionHint(tag) + listValueWidget(tag, row, i);
  }

  return (
    header +
    descriptionHint(tag) +
    '<div class="ve-values-fields"><div class="ve-values-field is-wide">' +
    valueEditorCell(tag, row, i) +
    '</div></div>'
  );
}

/** The Values tab; `selectedIndex` must be a row of `rows` when there are any. */
export function renderValuesTabHtml(
  state: ValuesState | null,
  rows: ValueRow[],
  rawMode: boolean,
  selectedIndex: number,
): string {
  if (!state) {
    return renderSkeleton();
  }

  if (rawMode) {
    return `
      <div class="raw-toggle">
        <button class="btn btn-sm"${actionAttrs('toggle-values-raw-mode')}>Switch to table view</button>
        <button class="btn btn-sm"${actionAttrs('download-values-json')}>Save to JSON file…</button>
        <button class="btn btn-sm"${actionAttrs('import-values-json')}>Import from JSON file…</button>
        <input type="file" id="import-values-file" accept="application/json,.json" style="display:none"${actionAttrs('import-values-file')} />
      </div>
      <textarea class="raw-editor" id="values-raw-editor" spellcheck="false"${actionAttrs('values-raw-input')}>${escapeHtml(JSON.stringify(toExportableValueRows(rows, state), null, 2))}</textarea>
      <div id="values-raw-issues"></div>
      <div class="hint">Editing the raw JSON directly. Must be an array of { name, value } entries — value may be a native JSON array for list-type variables (converted to MI's plain-string form on save).</div>
    `;
  }

  if (!rows.length) {
    return `
      <div class="raw-toggle">
        <button class="btn btn-sm"${actionAttrs('toggle-values-raw-mode')}>View/edit raw JSON</button>
        <button class="btn btn-sm"${actionAttrs('open-import-modal')}>⇄ Import from page…</button>
      </div>
      <div class="ve-values-layout">
        <div class="ve-values-nav">
          <div class="ve-values-nav-list"></div>
          <button type="button" class="ve-values-nav-item ve-values-nav-add"${actionAttrs('add-value-row')}>+ Add item</button>
        </div>
        <div class="ve-values-detail box-style"><div class="ve-values-empty">No variables yet.</div></div>
      </div>
    `;
  }

  const tags = rows.map((row) => schemaTagFor(state, row.name));
  const navHtml = rows.map((row, i) => valuesNavItemHtml(tags[i], row, i, i === selectedIndex)).join('');
  const detailHtml = rows
    .map(
      (row, i) =>
        '<div class="ve-values-anchor box-style' +
        (i === selectedIndex ? ' is-active' : '') +
        '" id="value-item-' +
        i +
        '" data-value-index="' +
        i +
        '">' +
        valuesDetailHtml(tags[i], row, i) +
        '</div>',
    )
    .join('');

  return `
    <div class="raw-toggle">
      <button class="btn btn-sm"${actionAttrs('toggle-values-raw-mode')}>View/edit raw JSON</button>
      <button class="btn btn-sm"${actionAttrs('open-import-modal')}>⇄ Import from page…</button>
    </div>
    <div class="ve-values-layout">
      <div class="ve-values-nav">
        <div class="ve-values-nav-list">${navHtml}</div>
      </div>
      <div class="ve-values-detail">${detailHtml}</div>
    </div>
  `;
}
