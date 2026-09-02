import { PageVariableTagEntry } from '../api/index.js';

export type PageVariableEntry = PageVariableTagEntry;

export type TemplateVariableTagType = 'text' | 'select' | 'multiselect' | 'file' | 'list' | 'color' | 'boolean';

/**
 * One entry of `public/__template_variables.json`'s `tags[]`.
 * Schema reverse-engineered from MI's backend — see TEMPLATE_VARIABLES.md at the repo root.
 */
export interface TemplateVariableTag {
  name: string;
  uid?: string;
  tag_type?: TemplateVariableTagType | string;
  tag_source?: string;
  default_value?: string;
  additional_options?: unknown;
  description?: string;
  use_hmtl_editor_ind?: 'Y' | 'N';
  use_raw_html_ind?: 'Y' | 'N';
  use_json_editor_ind?: 'Y' | 'N';
  javascript_code?: string;
}

export interface TemplateVariablesSchema {
  tags: TemplateVariableTag[];
  settings?: Record<string, unknown>;
}

export interface PageVariableValidationIssue {
  name: string;
  severity: 'warning' | 'error';
  message: string;
}

/**
 * A `list` tag's `additional_options`, when non-empty, is an array of these — each defines one
 * field/column of a list-of-objects item. A bare string entry is shorthand for
 * `{ name: <that string>, type: 'textarea' }`. Confirmed against MI's own page-variable editor
 * — see TEMPLATE_VARIABLES.md.
 */
export interface ListItemFieldConfig {
  name: string;
  type?: 'textarea' | 'color' | 'select' | 'multi-select' | 'file' | string;
  /** `select`/`multi-select` only. Defaults to `'static'`. Same per-source rules as the tag-level
   *  `tag_source`/`additional_options` pair (see TEMPLATE_VARIABLES.md) — just fed by `options`
   *  below instead of the tag's own `additional_options`. */
  source?: string;
  /** Not read by MI's own list-item value editor for `select`/`multi-select` — `options` (below)
   *  is what's actually used. Kept only because real exports carry the key; safe to ignore. */
  additional_options?: string;
  /** `select`/`multi-select` only — the option list itself when `source` is `'static'` (the
   *  default). For other `source` values, same rules as the tag-level `additional_options`
   *  apply (e.g. `dataset_data` still expects a dataset/column config, not this array). Same
   *  per-entry shape as the tag-level list too: a plain string, or an `{ id, text }` object. */
  options?: (string | { id?: string; text?: string })[];
}

// MI's own page-variable UI writes literal 'true'/'false' strings; the rest are accepted
// leniently for legacy/hand-edited data, since MI itself performs no validation on save.
const BOOLEAN_ALLOWED_VALUES = ['true', 'false', 'Y', 'N', '1', '0'];
const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function isOptionsWithEnumerableList(
  additionalOptions: unknown,
): additionalOptions is { id?: string; text?: string }[] {
  return Array.isArray(additionalOptions);
}

function optionMatches(option: { id?: string; text?: string }, token: string): boolean {
  return option.id === token || option.text === token;
}

/** A `ListItemFieldConfig.options` entry may be a plain string or an `{ id, text }` object
 *  (same shape as the tag-level list) — normalize before matching/display so an object entry
 *  never gets `.includes()`-compared or `.join()`-ed as `"[object Object]"`. */
function normalizeFieldOption(option: string | { id?: string; text?: string }): { id?: string; text: string } {
  if (typeof option === 'string') {
    return { id: option, text: option };
  }

  const text = option.text ?? option.id ?? '';

  return { id: option.id, text };
}

/** `null` when `additional_options` doesn't declare per-item fields (flat list of primitives). */
function normalizeListItemFields(additionalOptions: unknown): ListItemFieldConfig[] | null {
  if (!Array.isArray(additionalOptions) || additionalOptions.length === 0) {
    return null;
  }

  const fields = additionalOptions
    .map((entry): ListItemFieldConfig | null => {
      if (typeof entry === 'string') {
        return { name: entry, type: 'textarea' };
      }

      if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
        return entry as ListItemFieldConfig;
      }

      return null;
    })
    .filter((field): field is ListItemFieldConfig => field !== null);

  return fields.length ? fields : null;
}

/** Best-effort check of one field's value against its declared `ListItemFieldConfig.type`. */
function validateListItemFieldValue(
  tagName: string,
  itemLabel: string,
  field: ListItemFieldConfig,
  value: unknown,
): PageVariableValidationIssue[] {
  if (typeof value !== 'string') {
    return [
      {
        name: tagName,
        severity: 'warning',
        message: `${itemLabel}: field "${field.name}" should be a string, got ${typeof value}.`,
      },
    ];
  }

  if (!value) {
    return [];
  }

  switch (field.type) {
    case 'color':
      return COLOR_PATTERN.test(value)
        ? []
        : [
            {
              name: tagName,
              severity: 'warning',
              message: `${itemLabel}: field "${field.name}" value "${value}" is not a recognized color (expected e.g. "#075b7e").`,
            },
          ];

    case 'select': {
      if (!field.options?.length) {
        return [];
      }

      const options = field.options.map(normalizeFieldOption);

      return options.some((option) => optionMatches(option, value))
        ? []
        : [
            {
              name: tagName,
              severity: 'warning',
              message: `${itemLabel}: field "${field.name}" value "${value}" is not one of the declared options (${options.map((o) => o.text).join(', ')}).`,
            },
          ];
    }

    case 'multi-select': {
      if (!field.options?.length) {
        return [];
      }

      const options = field.options.map(normalizeFieldOption);
      const unmatched = value
        .split(',')
        .map((v) => v.trim())
        .filter((token) => !options.some((option) => optionMatches(option, token)));

      return unmatched.length
        ? [
            {
              name: tagName,
              severity: 'warning',
              message: `${itemLabel}: field "${field.name}" value "${unmatched.join(', ')}" is not among the declared options (${options.map((o) => o.text).join(', ')}).`,
            },
          ]
        : [];
    }

    default:
      return [];
  }
}

/** Best-effort validation of a `list` value's items against `additional_options` (`ListItemFieldConfig[]`). */
function validateListItems(tag: TemplateVariableTag, items: unknown[]): PageVariableValidationIssue[] {
  const fields = normalizeListItemFields(tag.additional_options);

  if (!fields) {
    return [];
  }

  const fieldNames = new Set(fields.map((field) => field.name));
  const issues: PageVariableValidationIssue[] = [];

  items.forEach((item, index) => {
    const itemLabel = `"${tag.name}" item #${index + 1}`;

    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      issues.push({
        name: tag.name,
        severity: 'warning',
        message: `${itemLabel} should be an object with field(s): ${fields.map((field) => field.name).join(', ')}.`,
      });

      return;
    }

    const itemRecord = item as Record<string, unknown>;

    for (const field of fields) {
      if (!(field.name in itemRecord)) {
        issues.push({
          name: tag.name,
          severity: 'warning',
          message: `${itemLabel} is missing field "${field.name}".`,
        });

        continue;
      }

      issues.push(...validateListItemFieldValue(tag.name, itemLabel, field, itemRecord[field.name]));
    }

    const extraKeys = Object.keys(itemRecord).filter((key) => !fieldNames.has(key));

    if (extraKeys.length) {
      issues.push({
        name: tag.name,
        severity: 'warning',
        message: `${itemLabel} has unexpected field(s) not declared in additional_options: ${extraKeys.join(', ')}.`,
      });
    }
  });

  return issues;
}

/**
 * Best-effort, non-blocking validation of a candidate value against its schema tag.
 * MI's own backend performs no such validation server-side (see TEMPLATE_VARIABLES.md
 * caveats), so every issue here is a `warning`, never an `error`.
 */
export function validateValueAgainstTag(tag: TemplateVariableTag, value: string): PageVariableValidationIssue[] {
  const issues: PageVariableValidationIssue[] = [];

  switch (tag.tag_type) {
    case 'boolean': {
      if (!BOOLEAN_ALLOWED_VALUES.includes(value)) {
        issues.push({
          name: tag.name,
          severity: 'warning',
          message: `Value "${value}" is not a recognized boolean encoding (expected one of ${BOOLEAN_ALLOWED_VALUES.join(', ')}).`,
        });
      }

      break;
    }

    case 'list': {
      try {
        const parsed = JSON.parse(value);

        if (!Array.isArray(parsed)) {
          issues.push({
            name: tag.name,
            severity: 'warning',
            message: `Value for list variable "${tag.name}" is valid JSON but not an array.`,
          });
        } else {
          issues.push(...validateListItems(tag, parsed));
        }
      } catch {
        issues.push({
          name: tag.name,
          severity: 'warning',
          message: `Value for list variable "${tag.name}" is not valid JSON.`,
        });
      }

      break;
    }

    case 'select':
    case 'multiselect': {
      if (isOptionsWithEnumerableList(tag.additional_options)) {
        const options = tag.additional_options;
        const tokens = tag.tag_type === 'multiselect' ? value.split(',').map((v) => v.trim()) : [value];
        const unmatched = tokens.filter((token) => !options.some((option) => optionMatches(option, token)));

        if (unmatched.length) {
          issues.push({
            name: tag.name,
            severity: 'warning',
            message: `Value "${unmatched.join(', ')}" does not match any declared option for "${tag.name}".`,
          });
        }
      }

      break;
    }

    default:
      break;
  }

  return issues;
}

/**
 * Everything currently known about the page's variables — live values, backfilled with
 * schema defaults for anything not yet set on the page.  `schema === null` degrades to the
 * live values as-is.
 */
export function buildPageVariablesExport(
  schema: TemplateVariablesSchema | null,
  live: PageVariableEntry[],
): PageVariableEntry[] {
  const schemaMap = new Map<string, TemplateVariableTag>((schema?.tags ?? []).map((tag) => [tag.name, tag]));
  const liveMap = new Map<string, string>(live.map((entry) => [entry.name, entry.value]));
  const knownNames = new Set<string>([...schemaMap.keys(), ...liveMap.keys()]);

  return Array.from(knownNames).map((name) => ({
    name,
    value: liveMap.get(name) ?? schemaMap.get(name)?.default_value ?? '',
  }));
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

export interface PageVariablesImportPlan {
  importable: ImportCandidate[];
  skipped: ImportSkip[];
}

/**
 * Whether `value` can structurally apply to `tag`'s type — a hard yes/no, unlike
 * `validateValueAgainstTag()`'s always-a-warning checks. Deliberately skips select/multiselect's
 * declared-option check: two pages can legitimately point a same-named select at different
 * datasets/sources, so an option-list mismatch doesn't mean the value can't apply.
 */
function typeCompatibilityIssue(tag: TemplateVariableTag, value: string): string | null {
  switch (tag.tag_type) {
    case 'boolean':
      return BOOLEAN_ALLOWED_VALUES.includes(value)
        ? null
        : `Not a recognized boolean value ("${value}").`;

    case 'color':
      return value === '' || COLOR_PATTERN.test(value) ? null : `Not a recognized color value ("${value}").`;

    case 'list': {
      if (value === '') {
        return null;
      }

      try {
        const parsed = JSON.parse(value);

        return parsed === null || Array.isArray(parsed) ? null : 'Value is valid JSON but not an array.';
      } catch {
        return 'Value is not valid JSON.';
      }
    }

    default:
      return null;
  }
}

/**
 * Plans an import of `sourceValues` (another page's live variable values) into the current
 * page's schema: matches by variable name first (anything unmatched is skipped outright), then
 * checks the matched value against the target tag's type. Nothing here writes anything — the
 * caller decides what to actually apply.
 */
export function planPageVariablesImport(
  schema: TemplateVariablesSchema | null,
  sourceValues: PageVariableEntry[],
): PageVariablesImportPlan {
  const schemaMap = new Map<string, TemplateVariableTag>((schema?.tags ?? []).map((tag) => [tag.name, tag]));
  const importable: ImportCandidate[] = [];
  const skipped: ImportSkip[] = [];

  for (const entry of sourceValues) {
    const tag = schemaMap.get(entry.name);

    if (!tag) {
      skipped.push({
        name: entry.name,
        sourceValue: entry.value,
        reason: "Not in the current page's schema.",
      });

      continue;
    }

    const issue = typeCompatibilityIssue(tag, entry.value);

    if (issue) {
      skipped.push({ name: entry.name, sourceValue: entry.value, reason: issue });

      continue;
    }

    importable.push({ name: entry.name, sourceValue: entry.value, tagType: tag.tag_type || 'text' });
  }

  return { importable, skipped };
}

