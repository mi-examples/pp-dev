# `__template_variables.json` schema (MI reference)

This file is what Metric Insights (MI) writes/reads for a Portal Page **template**'s variables — its definitions (types, defaults, per-field config) live here, while the *live* values a page currently has are stored separately on the page itself (see below). pp-dev's standalone [Variables Editor](./README.md#variables-editor) page (`src/lib/variables-editor.ts`, backed by `src/lib/page-variables-diff.ts`) reads and writes this file's contents; the older backup/sync flow (`src/lib/dist.service.ts`, `TEMPLATE_VARIABLES_FILE_NAME`) only ever tracked it as an opaque blob (hash) for diffing, never parsing it.

## File location

- Filename: `__template_variables.json`
- In a Portal Page project, it normally lives at `public/__template_variables.json`.
- Produced by MI when exporting a template's assets; consumed by MI when template assets are synced back (e.g. via git-sync, or saving the template in MI's own editor).

## Top-level shape

```jsonc
{
  "tags": [ /* TemplateVariableTag[] — see below */ ],
  "settings": {
    "image_capture_timeout": 0,
    "image_capture_on_event": "...",
    "image_capture_css_selector": "..."
  }
}
```

`tags` is the variable schema/definitions. `settings` is unrelated template-capture config — not a variable.

## `TemplateVariableTag` fields

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | Unique variable name. This is the key that appears in the live page's `tags` (`{name, value}[]`, see below) and in `[VarName]` placeholders substituted by `pp.middleware.ts#buildPage()`. |
| `uid` | `string` | Stable md5 identifier, survives renames across syncs. |
| `tag_type` | `enum` | One of: `text`, `select`, `multiselect`, `file`, `list`, `color`, `boolean`. (`boolean` is a newer addition — older templates may not have it.) |
| `tag_source` | `enum` | One of: `static`, `page`, `element`, `folder`, `segment`, `dataset`, `dataset_data`, `announcement`, `group`, `category`, `custom_attribute`, `page_entity`. Describes where the value/options come from, not the value's shape. |
| `default_value` | `string` | Default value for the variable. For `tag_type: "list"`, this is a **JSON-encoded array** (string-of-JSON, not a nested array). |
| `additional_options` | `array \| object \| string` | Decoded JSON in the exported file (re-stringified on ingest). Shape depends on `tag_type` and, for `select`/`multiselect`, on `tag_source` — see the dedicated section below for the full per-source breakdown. Always absent/unused for `boolean`. |
| `description` | `string` | Markdown, rendered as such in MI's editor UI. |
| `use_hmtl_editor_ind` | `'Y' \| 'N'` | Whether the value is edited via a rich HTML editor. |
| `use_raw_html_ind` | `'Y' \| 'N'` | When `'Y'`, MI skips XSS-encoding the value on save (see caveat below). |
| `use_json_editor_ind` | `'Y' \| 'N'` | Whether the value is edited via a JSON editor. |
| `javascript_code` | `string \| null` | Optional JS snippet, with `[value]` substituted at render time. |
| `display_order` | `number` | Present explicitly in real exports (not just implied by array index) — matches the tag's position in `tags`. |
| `portal_page_template_tag_id` | `number` | MI's internal row id for this tag. Not needed to write a schema by hand — MI regenerates it. |
| `portal_page_template_id` | `number` | The owning template's id — same for every tag in one file. |
| `use_js_code_ind` | `'Y' \| 'N'` | Companion flag for `javascript_code` (whether it's active), seen alongside `use_hmtl_editor_ind`/`use_raw_html_ind`/`use_json_editor_ind` in real exports. |

There is **no** `label` or `required` field, and no generic `options`/`enum` key — option lists live inside `additional_options`.

`javascript_code`/`use_js_code_ind` are real, change-tracked columns, but MI's current "Create/Edit Variable" form has no field for either — there's no live path to set them through that UI today. Treat them as legacy/reserved: safe to read and preserve on a round-trip, but not something to expect a human to fill in via MI's own tooling. pp-dev's Variables Editor matches this and doesn't expose an editor for them either — it still reads/writes them untouched as part of each tag object.

A real example covering every `tag_type` — including a dataset-driven `select` with non-enumerable `additional_options`, a flat-string `list`, and a column-defined `list` of objects (`ListItemFieldConfig[]`, see below) — lives at `tests/test-commonjs/public/__template_variables.json` in this repo.

## Live page variable values vs. the schema

The schema above (`__template_variables.json`) is **separate** from the live values stored on a Portal Page:

- Live values: `Page.tags` — a JSON string of `{name, value}[]` — fetched/set via a dedicated endpoint, **not** `/api/page`:
  - `GET /api/page_variable?page_id=<id>` → `{ tags: [{name, value}, ...] }`
  - `PUT /api/page_variable?page_id=<id>` with body `{ tags: "<JSON-stringified {name,value}[]>" }`
  - `page_id` is the preferred identifier for both — pp-dev uses it exclusively (see `src/api/page-variable.ts`, `PageVariableAPI#getById`/`#updateById`). `internal_name` also works as a fallback (`?internal_name=<name>` on either verb) but requires an extra page lookup to resolve first if you only have the numeric page id, so there's no reason to use it here.
  - The route also accepts an `id`-style path/query param (`/api/page_variable/id/{id}`, `?id=...`) for **PUT only** — for **GET**, sending an `id` routes to a handler that's explicitly disabled, so **`id` must never be used for GET** — use `page_id` instead.
  - MI resolves the page for this endpoint via `page_id` first, falling back to `internal_name` only when `page_id` is absent.
- MI's tag-saving logic does **not** validate a value against the variable's declared `tag_type`. It only special-cases `tag_type === 'list'` (JSON encode/decode the array + XSS-encode each element) vs. everything else (plain XSS-encode as a string), and skips encoding entirely when `use_raw_html_ind === 'Y'` or `use_hmtl_editor_ind === 'Y'`. So `select`, `multiselect`, `boolean`, `color`, and `file` values are all persisted as unvalidated strings by MI itself — there is no server-side type/enum enforcement to lean on.

## `list` of objects — `additional_options` as `ListItemFieldConfig[]`

A `list` variable isn't limited to flat strings. When `additional_options` is a non-empty array, MI's own page-variable editor treats each entry as a **column definition** and renders each list item as an object keyed by those column names — this is a real, first-class MI feature, not something pp-dev invented.

```ts
interface ListItemFieldConfig {
  name: string;                 // becomes the object key on each list item
  type: 'textarea' | 'color' | 'select' | 'multi-select' | 'file';
  source?: string;               // select/multi-select only — where THIS field's options come from
  additional_options?: string;   // not actually read for select/multi-select — see below
  options?: string[];            // select/multi-select only — the option list itself
}
```

A bare string in the array is shorthand for `{ name: <that string>, type: 'textarea' }`. With `additional_options` empty (`""`), items fall back to being plain strings. `tests/test-commonjs/public/__template_variables.json` in this repo has both variants side by side: `variable-list` (flat strings) and `variable-list-objects` (column-defined — `additional_options: [{name:"id",type:"textarea"},{name:"label",type:"textarea"}]`, items like `{"id":"1","label":"First"}`).

For a `select`/`multi-select` column, `source` (defaults to `'static'` if omitted) and `options` together follow the **exact same per-source rules** as the tag-level `tag_source`/`additional_options` pair described above — just fed by `options` (a plain `string[]`) instead of the tag's own `additional_options`. Concretely: with `source: 'static'` (or omitted), `options` **is** the list of choices; for any other `source`, the same live-loading/ignored-field rules apply, just scoped to this one column instead of the whole tag. MI's own list-item value editor never actually reads this column config's `additional_options` — only `options` — so leave it out rather than mirroring the tag-level shape here.

pp-dev validates list items against this schema (`validateListItems` in `src/lib/page-variables-diff.ts`, best-effort/warning-only like everything else here): each item must be an object with every declared field present and no undeclared extra fields, `color` fields must match a hex pattern, and `select`/`multi-select` fields are checked against `options` (a plain `string[]`) when present. A flat list (empty `additional_options`) skips all of this — items are just left as whatever they are.

## `list` values in the Variables Editor's Values-tab JSON mode

On the wire (and in `default_value`), a `list` value is always a **JSON-encoded array packed into a string** — e.g. the string `["a","b"]`, not a nested array. Written naively into a JSON file, that means double-escaping: `"value": "[\"a\",\"b\"]"`.

To avoid making a human write that by hand, the Variables Editor's Values tab — both its JSON mode (`View/edit raw JSON`, including the Save/Import-to-file buttons) and the file it writes — allows `value` to be a **native JSON array** for `list`-type entries — `"value": ["a","b"]` — and converts at the display/parse boundary only (`toExportableValueRows`/`fromExportableValueRows` in `src/lib/variables-editor.ts`):

- **Display/export**: for any entry whose schema tag has `tag_type: "list"`, the stored string is `JSON.parse`'d back into a native array before it's shown in the JSON textarea or saved to a file, falling back to the raw string if it isn't valid JSON.
- **Parse/import**: the reverse — if `value` isn't a string, it's `JSON.stringify`'d immediately into MI's plain-string form before being sent anywhere.
- Everything in between — the `PUT /@api/variables/values` endpoint and `page-variables-diff.ts`'s export/validation logic — only ever sees plain strings; neither has any awareness of this convenience conversion.

## What MI's own "Create/Edit Variable" form actually shows

MI's schema-authoring UI is a hardcoded type switch, not generically schema-driven, so which fields it shows/asks for depends on `tag_type` (and, in one case, `tag_source`):

- **Name**: must match `/^[A-Za-z0-9_\s-]+$/` (letters, digits, underscore, whitespace, hyphen) and be unique — both enforced client-side before MI will save it.
- **`tag_source` picker**: shown only for `tag_type: "select"`/`"multiselect"`. Every other type is created as `static` with no way to pick a different source through this form.
- **`use_hmtl_editor_ind` ("Use WYSIWYG Editor")**: shown only for `tag_type: "text"`. Checking it forces `use_raw_html_ind`/`use_json_editor_ind` off (mutually exclusive).
- **`use_raw_html_ind` ("Raw HTML")** / **`use_json_editor_ind` ("Use JSON Editor")**: shown for `tag_type: "text"` or `"list"`; for `"text"`, only while WYSIWYG isn't checked. Not offered for `select`/`multiselect`/`file`/`color`/`boolean`.
- **`default_value`**: shown only for `tag_type: "text"` or `"list"`. There's no way to set a default through this form for `select`/`multiselect`/`file`/`color`/`boolean`.
- **`additional_options`**: shown for `text`/`file`/`list`/`color`, and for `select`/`multiselect` only when `tag_source` is `static`/`segment`/`element`/`dataset_data` (the sources whose options aren't loaded live). Never shown for `boolean`.

None of this is server-enforced (see below) — it's purely what the authoring form itself lets a human enter. A hand-written or MI-exported file can still legally contain combinations this form would never produce (e.g. a `default_value` on a `select` tag from an older export).

## `additional_options` per `tag_type`/`tag_source` — what MI's options-loading endpoint actually reads

The create-form's field visibility above is about what a human can *type into*; this is about what MI's backend actually *reads back out* when it needs to list a `select`/`multiselect` variable's options. The two don't always agree:

- **`select`/`multiselect`, `tag_source: "static"`**: `additional_options` **is** the option list — an array where each entry is either a plain string, or an object with `id`/`text`: `[{"id":"1","text":"One"},"Two"]`. A plain string entry uses itself as both the stored value and the label.
- **`select`/`multiselect`, `tag_source: "dataset_data"`**: `{dataset_id, key_column, text_column}` — MI pulls id/label pairs live from that dataset, using `key_column` for the id and `text_column` for the label.
- **`select`/`multiselect`, `tag_source: "element"`**: optional — `{"type": "metric" | "multi-metric chart" | "internal report" | "external report" | "other external content"}` narrows the dashboard-element list to one type. Omit it to list every element.
- **`select`/`multiselect`, `tag_source: "segment"`**: the create form shows this field for `segment`, but MI's options-loading endpoint never actually reads it for this source — the segment list always comes back unfiltered regardless of what's in `additional_options`. A form/backend inconsistency, not a feature to rely on.
- **`select`/`multiselect`, any other `tag_source`** (`dataset`, `announcement`, `group`, `category`, `custom_attribute`, `page`, `page_entity`): ignored entirely — MI queries its own live data for that source instead.
- **`list`**: see the dedicated section below (`ListItemFieldConfig[]`).
- **`text`/`file`/`color`**: the create form accepts input here, but no runtime consumer of it was found — treat as unused/reserved.
- **`boolean`**: not shown in the create form at all, and unused.

## Caveats for any pp-dev feature built on this

- `boolean` values are the literal strings `'true'`/`'false'` (confirmed against MI's own page-variable value editor — it renders a two-option radio group with exactly those values). MI performs no coercion, so a hand-edited or legacy file could still contain something else (`'Y'`/`'N'`, `'1'`/`'0'`) and MI would persist it as-is without complaint.
- `multiselect` values are stored as a single comma-joined string (e.g. `"a,b,c"`), not JSON — unlike `list`, which is JSON-encoded (see above).
- `file` values are just a filename string, with no schema-declared shape. MI's own upload control restricts the actual upload to images (`jpg`/`jpeg`/`png`/`gif`/`svg`) — a hand-set value of a different extension isn't rejected by anything server-side, just unlikely to render as an image. There's no public API (only whole-bundle asset zip download/upload — see above) for listing or uploading a page's individual file assets, so pp-dev's Variables Editor only offers a manual path input for this type, no browse/upload button.
- Because MI performs no type/enum validation server-side, any client-side (pp-dev) validation against `tag_type`/`additional_options` is a **best-effort convenience check**, not something MI itself guarantees or requires.
