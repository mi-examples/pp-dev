// The Schema tab's HTML (the `__template_variables.json` tags as a table) and the rules it shows
// fields by. Controls say what they do in `data-action` (with `data-index`, `data-field`, …);
// editor.ts handles their events in one place.
import { actionAttrs, escapeHtml, normalizeOptionEntry, renderSkeleton } from './html.js';
import type {
  EditorFlagField,
  FieldVisibility,
  ListColumn,
  SchemaChoiceField,
  SchemaState,
  SchemaTag,
} from './types.js';

export const KNOWN_TYPES = ['text', 'select', 'multiselect', 'file', 'list', 'color', 'boolean'];

const KNOWN_TAG_SOURCES = [
  'static',
  'page',
  'element',
  'folder',
  'segment',
  'dataset',
  'dataset_data',
  'announcement',
  'group',
  'category',
  'custom_attribute',
  'page_entity',
];
// select/multiselect sources whose options are hand-entered via additional_options rather than
// loaded live from MI (the rest — dataset/announcement/group/category/custom_attribute/page/
// page_entity — populate their own option list, so additional_options doesn't apply there).
const HAND_ENTERED_OPTION_SOURCES = ['static', 'segment', 'element', 'dataset_data'];
// list-tag column editor: field types + sources allowed on a select/multi-select column.
const LIST_COLUMN_TYPES = ['textarea', 'select', 'multi-select', 'color', 'file'];
const LIST_COLUMN_SOURCES = ['static', 'dataset', 'group', 'category', 'custom_attribute'];
// Matches MI's own "Create/Edit Variable" form: letters, digits, underscore, whitespace, hyphen.
const NAME_FORMAT_REGEX = /^[A-Za-z0-9_\s-]+$/;

// A styled <select> (not a native <datalist>, whose popup/selected-state styling browsers
// won't let us theme) with an escape hatch: picking "Custom…" prompts for any string, so a
// tag_type/tag_source MI adds in the future can be configured here without a pp-dev code change.
export const CUSTOM_TYPE_SENTINEL = '__custom__';

function customSelectCell(
  field: SchemaChoiceField,
  knownValues: string[],
  fallback: string,
  tag: SchemaTag,
  i: number,
): string {
  const currentValue = tag[field] || fallback;
  const isKnown = knownValues.includes(currentValue);
  const knownOptions = knownValues
    .map((v) => '<option value="' + v + '"' + (currentValue === v ? ' selected' : '') + '>' + v + '</option>')
    .join('');
  const customOption =
    !currentValue || isKnown
      ? ''
      : '<option value="' + escapeHtml(currentValue) + '" selected>' + escapeHtml(currentValue) + ' (custom)</option>';

  return (
    '<select' +
    actionAttrs('custom-select', { index: i, field }) +
    '>' +
    knownOptions +
    customOption +
    '<option value="' +
    CUSTOM_TYPE_SENTINEL +
    '">Custom…</option>' +
    '</select>'
  );
}

function typeSelectCell(tag: SchemaTag, i: number): string {
  return customSelectCell('tag_type', KNOWN_TYPES, 'text', tag, i);
}

function tagSourceSelectCell(tag: SchemaTag, i: number): string {
  return customSelectCell('tag_source', KNOWN_TAG_SOURCES, '', tag, i);
}

// Short, one-line version for inline display next to the field — click "?" for the full
// per-tag_source breakdown (additionalOptionsDetails()) with examples, shown in a modal.
function additionalOptionsHint(tag: SchemaTag): string {
  const tagType = tag.tag_type;

  if (tagType === 'select' || tagType === 'multiselect') {
    const source = tag.tag_source || 'static';

    if (source === 'static') {
      return 'The option list itself.';
    }

    if (source === 'dataset_data') {
      return 'Which dataset + columns to pull options from.';
    }

    if (source === 'element') {
      return 'Optional filter by element type.';
    }

    if (source === 'segment') {
      return "Accepted by MI's form, but not read for this source.";
    }

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
// shown in a modal (the "?" next to the field) so the inline hint above can stay short.
export function additionalOptionsDetails(tag: SchemaTag): string {
  const tagType = tag.tag_type;

  if (tagType === 'select' || tagType === 'multiselect') {
    const source = tag.tag_source || 'static';

    if (source === 'static') {
      return (
        '<p>The option list itself. Each entry is a plain string, or an object with <code>id</code>/<code>text</code>:</p>' +
        '<pre>[{"id":"1","text":"One"},"Two"]</pre>' +
        '<p>A plain string entry uses itself as both the stored value and the label.</p>'
      );
    }

    if (source === 'dataset_data') {
      return (
        '<p>Pulls options live from a dataset, by column name:</p>' +
        '<pre>{"dataset_id":123,"key_column":"id_col","text_column":"name_col"}</pre>' +
        '<p><code>key_column</code> supplies the option value, <code>text_column</code> the label.</p>'
      );
    }

    if (source === 'element') {
      return (
        '<p>Optional — restricts the dashboard-element list to one type:</p>' +
        '<pre>{"type":"metric"}</pre>' +
        '<p>Accepted values: <code>metric</code>, <code>multi-metric chart</code>, <code>internal report</code>, <code>external report</code>, <code>other external content</code>. Leave empty to list all elements.</p>'
      );
    }

    if (source === 'segment') {
      return '<p>MI\'s own "Create/Edit Variable" form shows this field for tag_source "segment", but its options-loading endpoint never actually reads it — the segment list always comes back unfiltered. Best left empty.</p>';
    }

    return (
      '<p>Not used — for tag_source "' +
      escapeHtml(source) +
      '", MI loads options live from its own data (e.g. the dataset/announcement/group/category/page list) and never consults this field.</p>'
    );
  }

  if (tagType === 'list') {
    return (
      '<p>An array of column definitions — each list item becomes an object keyed by these names:</p>' +
      '<pre>[{"name":"id","type":"textarea"},{"name":"color","type":"color"}]</pre>' +
      '<p>A bare string entry is shorthand for <code>{"name": &lt;that string&gt;, "type": "textarea"}</code>. Leave as <code>""</code> (empty string) instead for a flat list of plain strings.</p>' +
      '<p>Supported field <code>type</code>s: <code>textarea</code>, <code>color</code>, <code>select</code>, <code>multi-select</code>, <code>file</code>.</p>' +
      '<p>For a <code>select</code>/<code>multi-select</code> column, add <code>source</code> (defaults to <code>"static"</code>) and <code>options</code> — same per-source rules as the tag-level <code>tag_source</code>/<code>additional_options</code> above, just scoped to this one column and fed by <code>options</code> instead:</p>' +
      '<pre>{"name":"country","type":"select","options":["USA","Canada"]}</pre>' +
      "<p>MI's own list-item editor never reads this column's own <code>additional_options</code> — only <code>options</code> — so leave it out.</p>"
    );
  }

  if (tagType === 'boolean') {
    return "<p>MI's own editor doesn't show this field for tag_type \"boolean\", and there's no known runtime use for it — leave empty.</p>";
  }

  return (
    '<p>MI\'s own editor lets you fill this in for tag_type "' +
    escapeHtml(tagType || 'text') +
    '", but there\'s no confirmed runtime consumer for it — treat it as unused/reserved.</p>'
  );
}

export const LIST_COLUMNS_HELP_HTML =
  '<p>An array of column definitions — each list item becomes an object keyed by these names. Supported field <code>types</code>: <code>textarea</code>, <code>color</code>, <code>select</code>, <code>multi-select</code>, <code>file</code>.</p>' +
  '<p>Edited below as a column editor — reordering/adding/removing there is the same thing as hand-editing this JSON array, just without needing to write JSON.</p>';

// Mirrors MI's own "Create/Edit Variable" form: which fields it shows/hides depends on
// tag_type (and, for the tag_source picker and additional_options, tag_source too). For a
// tag_type MI hasn't defined yet (i.e. a custom one entered via typeSelectCell's escape hatch),
// there's no such logic to mirror, so give full access to everything instead of guessing.
function fieldVisibility(tag: SchemaTag): FieldVisibility {
  const type = tag.tag_type;

  if (!KNOWN_TYPES.includes(type as string)) {
    return {
      tagSource: true,
      useHtml: true,
      rawHtml: true,
      useJson: true,
      defaultValue: true,
      additionalOptions: true,
    };
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
      type === 'text' ||
      type === 'file' ||
      type === 'list' ||
      type === 'color' ||
      (isSelectLike && HAND_ENTERED_OPTION_SOURCES.indexOf(source) !== -1),
  };
}

function checkboxField(label: string, checked: boolean, attrs: string): string {
  return (
    '<label class="checkbox-label"><input type="checkbox" ' +
    (checked ? 'checked' : '') +
    ' ' +
    attrs +
    ' />' +
    escapeHtml(label) +
    '</label>'
  );
}

function editorFlagsRow(tag: SchemaTag, i: number, vis: FieldVisibility): string {
  if (!vis.useHtml && !vis.rawHtml && !vis.useJson) {
    return '';
  }

  const parts: string[] = [];
  const flag = (label: string, field: EditorFlagField) =>
    checkboxField(label, tag[field] === 'Y', actionAttrs('editor-flag', { index: i, field }).trim());

  if (vis.useHtml) {
    parts.push(flag('Use WYSIWYG Editor', 'use_hmtl_editor_ind'));
  }

  if (vis.rawHtml) {
    parts.push(flag('Raw HTML', 'use_raw_html_ind'));
  }

  if (vis.useJson) {
    parts.push(flag('Use JSON Editor', 'use_json_editor_ind'));
  }

  return '<div style="grid-column:1/-1" class="checkbox-row">' + parts.join('') + '</div>';
}

function nameWarningHint(name: string | undefined): string {
  if (!name) {
    return '<div class="hint" style="color:var(--red)">Name is required.</div>';
  }

  if (!NAME_FORMAT_REGEX.test(name)) {
    return '<div class="hint" style="color:var(--red)">Contains a character MI\'s own editor doesn\'t allow — only letters, digits, underscore, hyphen, and whitespace.</div>';
  }

  return '';
}

// Normalize list-tag additional_options into editable column objects. Non-array values
// (flat-list "" / invalid raw text) become an empty column list — editing via the UI replaces them.
export function listColumnsFor(tag: SchemaTag | undefined): ListColumn[] {
  const opts = tag && tag.additional_options;

  if (!Array.isArray(opts)) {
    return [];
  }

  return (opts as (string | ListColumn)[]).map((c) =>
    typeof c === 'string' ? { name: c, type: 'textarea' } : Object.assign({}, c),
  );
}

// Persist select/multi-select columns without a redundant source when options are present —
// source is only kept when there is no options list (non-static / empty options).
export function normalizeListColumn(col: ListColumn): ListColumn {
  const out: ListColumn = Object.assign({ name: '', type: 'textarea' }, col);
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

function listColumnSelectOptions(values: string[], selected: string): string {
  return values
    .map(
      (v) =>
        '<option value="' +
        escapeHtml(v) +
        '"' +
        (v === selected ? ' selected' : '') +
        '>' +
        escapeHtml(v) +
        '</option>',
    )
    .join('');
}

function listColumnItemHtml(col: ListColumn, i: number, colIndex: number): string {
  const name = col.name != null ? String(col.name) : '';
  const type = col.type || 'textarea';
  const isSelect = type === 'select' || type === 'multi-select';
  const source = col.source || 'static';
  // Same { id, text } | string shape as the Values tab's select widget (see listItemFieldsHtml())
  // — show the readable text, not "[object Object]", for a column with object-shaped options.
  // Editing this comma-separated field still only ever writes back plain strings (id === text) —
  // this UI has never round-tripped distinct id/text pairs, only raw JSON editing does.
  const optionsText = Array.isArray(col.options) ? col.options.map((o) => normalizeOptionEntry(o).text).join(', ') : '';
  const at = { index: i, col: colIndex };

  const typeOptions = listColumnSelectOptions(
    LIST_COLUMN_TYPES.indexOf(type) !== -1 ? LIST_COLUMN_TYPES : LIST_COLUMN_TYPES.concat([type]),
    type,
  );

  let bottom =
    '<div class="ve-ao-column-field">' +
    '<label>type</label>' +
    '<select' +
    actionAttrs('list-column-field', { ...at, field: 'type' }) +
    '>' +
    typeOptions +
    '</select>' +
    '</div>';

  if (isSelect) {
    const sourceOptions = listColumnSelectOptions(
      LIST_COLUMN_SOURCES.indexOf(source) !== -1 ? LIST_COLUMN_SOURCES : LIST_COLUMN_SOURCES.concat([source]),
      source,
    );

    bottom +=
      '<div class="ve-ao-column-field">' +
      '<label>source</label>' +
      '<select' +
      actionAttrs('list-column-field', { ...at, field: 'source' }) +
      '>' +
      sourceOptions +
      '</select>' +
      '</div>';

    if (source === 'static') {
      bottom +=
        '<div class="ve-ao-column-field">' +
        '<label>options</label>' +
        '<input type="text" value="' +
        escapeHtml(optionsText) +
        '" placeholder="Options (comma-separated)"' +
        actionAttrs('list-column-options', at) +
        ' />' +
        '</div>';
    }
  }

  return (
    '<div class="ve-ao-column" data-row="' +
    i +
    '" data-col-index="' +
    colIndex +
    '" data-drop="list-column">' +
    '<span class="ve-ao-column-handle" draggable="true" data-drag="list-column" title="Drag to reorder" aria-label="Drag to reorder" role="button" tabindex="0">⠿</span>' +
    '<div class="ve-ao-column-fields">' +
    '<div class="ve-ao-column-top">' +
    '<div class="ve-ao-column-field">' +
    '<label>name</label>' +
    '<div class="ve-ao-column-name">' +
    '<input type="text" value="' +
    escapeHtml(name) +
    '"' +
    actionAttrs('list-column-name', at) +
    ' placeholder="Column name" />' +
    '<button type="button" class="btn btn-sm ve-ao-column-remove"' +
    actionAttrs('remove-list-column', at) +
    ' title="Remove column">✕</button>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '<div class="ve-ao-column-bottom">' +
    bottom +
    '</div>' +
    '</div>' +
    '</div>'
  );
}

function listColumnsEditorHtml(tag: SchemaTag, i: number): string {
  const cols = listColumnsFor(tag);
  const itemsHtml = cols.map((col, colIndex) => listColumnItemHtml(col, i, colIndex)).join('');

  return (
    '<div class="box-style" style="grid-column:1/-1">' +
    '<label>additional_options (UI version)<button type="button" class="btn btn-sm" style="text-transform:none;padding:0 6px;margin-left:4px"' +
    actionAttrs('show-list-columns-help') +
    ' title="What is additional_options for list?">?</button></label>' +
    '<div class="ve-ao-columns">' +
    itemsHtml +
    '</div>' +
    '<button type="button" class="btn btn-sm" style="margin-top:8px"' +
    actionAttrs('add-list-column', { index: i }) +
    '>+ Add column</button>' +
    '</div>'
  );
}

function schemaRowHtml(tag: SchemaTag, i: number): string {
  const vis = fieldVisibility(tag);
  // An empty string means "not set" (the flat-list/no-options convention) — show it as an
  // empty field instead of the literal two-character JSON string '""'.
  const additionalOptionsRaw =
    tag.additional_options !== undefined && tag.additional_options !== '' ? JSON.stringify(tag.additional_options) : '';
  const field = (name: string) => actionAttrs('schema-field', { index: i, field: name });

  const defaultValueCell = vis.defaultValue
    ? '<textarea class="cell-textarea"' +
      field('default_value') +
      ' data-autosize>' +
      escapeHtml(tag.default_value || '') +
      '</textarea>'
    : '<textarea class="cell-textarea" disabled title="MI\'s own editor has no Default Value field for this tag_type.">' +
      escapeHtml(tag.default_value || '') +
      '</textarea>';

  const tagSourceCell = vis.tagSource
    ? tagSourceSelectCell(tag, i)
    : '<span class="badge">' +
      escapeHtml(tag.tag_source || 'static') +
      '</span> <div class="hint">Only configurable for select/multiselect in MI\'s own editor.</div>';

  const additionalOptionsCell = vis.additionalOptions
    ? '<textarea id="ao-raw-' +
      i +
      '"' +
      actionAttrs('schema-additional-options', { index: i }) +
      '>' +
      escapeHtml(additionalOptionsRaw) +
      '</textarea>'
    : '<textarea id="ao-raw-' +
      i +
      '" disabled title="Not used for this tag_type/tag_source combination in MI\'s own editor.">' +
      escapeHtml(additionalOptionsRaw) +
      '</textarea>';

  const listColumnsEditor = tag.tag_type === 'list' ? listColumnsEditorHtml(tag, i) : '';

  return `
    <tr class="schema-row" data-row-index="${i}" data-drop="schema-row">
      <td class="col-expand">
        <div class="ve-expand-cell">
          <span class="ve-schema-row-handle" draggable="true" data-drag="schema-row" title="Drag to reorder" aria-label="Drag to reorder" role="button" tabindex="0">⠿</span>
          <button class="btn btn-sm ve-expand-btn" id="expand-btn-${i}"${actionAttrs('toggle-schema-advanced', { index: i })} aria-expanded="false" title="Advanced fields (uid, tag_source, additional_options, editor flags)">▸</button>
        </div>
      </td>
      <td class="col-name">
        <input type="text" value="${escapeHtml(tag.name || '')}"${field('name')} />
        ${nameWarningHint(tag.name)}
      </td>
      <td class="col-type">${typeSelectCell(tag, i)}</td>
      <td>${defaultValueCell}</td>
      <td><textarea class="cell-textarea"${field('description')} data-autosize>${escapeHtml(tag.description || '')}</textarea></td>
      <td class="col-actions">
        <button class="btn btn-sm"${actionAttrs('remove-schema-row', { index: i })}>✕</button>
      </td>
    </tr>
    <tr class="details-row" id="advanced-${i}" data-row-index="${i}" style="display:none;" data-drop="schema-row">
      <td colspan="6" style="border:none;">
        <div class="details-grid">
          <div class="details-grid-item-wrapper">
            <div class="box-style"><label>uid</label><input type="text" value="${escapeHtml(tag.uid || '')}"${field('uid')} /></div>
            <div class="box-style"><label>tag_source</label>${tagSourceCell}</div>
            <div class="box-style" style="height:fit-content;">${editorFlagsRow(tag, i, vis)}</div>
          </div>
          <div class="box-style" style="grid-column:1/-1">
            <label>additional_options (raw JSON) <button type="button" class="btn btn-sm" style="text-transform:none;padding:0 6px;margin-left:4px"${actionAttrs('show-additional-options-help', { index: i })} title="What goes here for this type/source?">?</button></label>
            ${additionalOptionsCell}
            <div class="hint">${additionalOptionsHint(tag)}</div>

          </div>
          ${listColumnsEditor}
        </div>
      </td>
    </tr>
  `;
}

export function renderSchemaTabHtml(
  schemaState: SchemaState | null,
  rawMode: boolean,
  schemaRows: SchemaTag[],
): string {
  if (!schemaState) {
    return renderSkeleton();
  }

  if (rawMode) {
    return `
      <div class="raw-toggle"><button class="btn btn-sm"${actionAttrs('toggle-raw-mode')}>Switch to table view</button></div>
      ${schemaState.parseError ? '<div class="banner banner-error">The file is not a valid schema: ' + escapeHtml(schemaState.parseError) + '</div>' : ''}
      <textarea class="raw-editor" id="raw-editor"${actionAttrs('set-dirty')}>${escapeHtml(schemaState.raw || '')}</textarea>
      <div class="hint">Editing the raw file text directly. Must be valid JSON with a top-level "tags" array.</div>
    `;
  }

  if (!schemaState.exists) {
    return `<div class="empty-state">No local __template_variables.json found.<br><button class="btn btn-sm" style="margin-top:10px"${actionAttrs('add-schema-row')}>Create one — add first variable</button></div>`;
  }

  const rows = schemaRows.map(schemaRowHtml).join('');

  return `
    <div class="raw-toggle"><button class="btn btn-sm"${actionAttrs('toggle-raw-mode')}>View/edit raw JSON</button></div>
    <table>
      <thead><tr><th class="col-expand"></th><th class="col-name">Name</th><th class="col-type">Type</th><th>Default value</th><th>Description</th><th class="col-actions"></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="empty-state">No variables yet.</td></tr>'}</tbody>
    </table>
    <button class="btn btn-sm" style="margin-top:10px"${actionAttrs('add-schema-row')}>+ Add variable</button>
    <div class="hint">Pick a known type, or choose "Custom…" to enter any value if MI adds a new tag_type.</div>
  `;
}

// A new variable's uid: 32 hex digits, the shape of the MD5-based uids MI gives its own.
export function newUid(): string {
  const bytes = new Uint8Array(16);

  crypto.getRandomValues(bytes);

  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
