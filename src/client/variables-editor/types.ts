// The data the Variables Editor reads from and sends to the dev server's /@api/variables/* routes
// (src/lib/variables-editor.ts), as the page sees it: a hand-edited file can leave any field out.

/** One entry of `__template_variables.json`'s `tags[]` (see TEMPLATE_VARIABLES.md). */
export interface SchemaTag {
  name?: string;
  uid?: string;
  tag_type?: string;
  tag_source?: string;
  default_value?: string;
  /** Option list, column definitions or a source config, depending on tag_type/tag_source; `''` for none. */
  additional_options?: unknown;
  description?: string;
  use_hmtl_editor_ind?: string;
  use_raw_html_ind?: string;
  use_json_editor_ind?: string;
}

/** The fields the Schema tab edits as plain text. */
export type SchemaTextField = 'name' | 'uid' | 'default_value' | 'description';

/** The fields picked from a known list, or "Custom…". */
export type SchemaChoiceField = 'tag_type' | 'tag_source';

/** The three editor-flag checkboxes ('Y'/'N'). */
export type EditorFlagField = 'use_hmtl_editor_ind' | 'use_raw_html_ind' | 'use_json_editor_ind';

/** The schema file's JSON: a `tags` array, and whatever else the file has (kept as it is). */
export interface SchemaDocument {
  tags: SchemaTag[];
  [key: string]: unknown;
}

/** `GET /@api/variables/schema`. */
export interface SchemaState {
  exists: boolean;
  /** `null` when the file isn't a JSON object with a `tags` array. */
  schema: SchemaDocument | null;
  raw: string | null;
  /** Why {@link schema} is `null`. */
  parseError?: string;
}

/** A variable's value as the Values tab edits it (MI's plain-string form). */
export interface ValueRow {
  name: string;
  value: string;
}

/** A value as MI or the local pages hold it; a missing value differs from an empty one. */
export interface PageValue {
  name: string;
  value?: string | null;
}

/** `GET /@api/variables/values`. */
export interface ValuesState {
  schema: { tags?: SchemaTag[] } | null;
  live: PageValue[];
  /** What to show: every schema variable, with its live value. */
  combined?: ValueRow[];
  /** What the local pages show; `null` before they loaded the page data. */
  local?: PageValue[] | null;
}

/** A value in the JSON mode and file: a list-type value as a native JSON array. */
export interface ExportableValueRow {
  name: string;
  value: unknown;
}

/** An option of a select: a plain string (its own id and text), or `{ id, text }`. */
export type OptionEntry = string | { id?: unknown; text?: unknown };

export interface NormalizedOption {
  id: string;
  text: string;
}

/** A column of a list tag's items (its `additional_options` entries). */
export interface ListColumn {
  name?: string;
  type?: string;
  /** For a select/multi-select column; `static` when there are no options. */
  source?: string;
  options?: OptionEntry[];
}

/** Which of a tag's fields MI's own "Create/Edit Variable" form shows for its type and source. */
export interface FieldVisibility {
  tagSource: boolean;
  useHtml: boolean;
  rawHtml: boolean;
  useJson: boolean;
  defaultValue: boolean;
  additionalOptions: boolean;
}

/** A flagged entry of the Values tab's JSON mode. */
export interface JsonIssue {
  name: string;
  message: string;
}

/** An error answer of the API. */
export interface ErrorBody {
  error?: string;
  details?: string;
}

/** `PUT /@api/variables/schema`. */
export interface SchemaSaveResponse {
  ok: boolean;
  warnings?: string[];
}

/** `PUT /@api/variables/values`. */
export interface ValuesSaveResponse {
  ok: boolean;
  warnings?: { name: string; severity: string; message: string }[];
  local?: PageValue[] | null;
  /** Why the local pages weren't updated with the save. */
  localError?: string;
}

/** `POST /@api/variables/values/local`. */
export interface LocalValuesResponse extends ErrorBody {
  local?: PageValue[] | null;
}

/** A page of `GET /@api/variables/pages`. */
export interface ImportPage {
  id: number;
  name: string;
  internal_name: string;
  /** Uses the same template as the page being edited. */
  sameTemplate: boolean;
}

export interface PagesResponse extends ErrorBody {
  pages?: ImportPage[];
}

export interface ImportCandidate {
  name: string;
  sourceValue: string;
  tagType: string;
}

export interface ImportSkip {
  name: string;
  sourceValue: string;
  reason: string;
}

/** `GET /@api/variables/import-plan/:pageId`. */
export interface ImportPlan extends ErrorBody {
  importable?: ImportCandidate[];
  skipped?: ImportSkip[];
}
