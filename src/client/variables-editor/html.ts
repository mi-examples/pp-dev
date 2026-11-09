// Small helpers the Variables Editor's HTML builders share.
import type { NormalizedOption, OptionEntry } from './types.js';

export function escapeHtml(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * ` data-action="…"` and the other `data-*` attributes the editor's delegated listeners read
 * (camelCase keys become kebab-case; `null`/`undefined` ones are left out), escaped.
 */
export function actionAttrs(action: string, data: Record<string, string | number | null | undefined> = {}): string {
  let attrs = ' data-action="' + escapeHtml(action) + '"';

  for (const [key, value] of Object.entries(data)) {
    if (value != null) {
      attrs += ' data-' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) + '="' + escapeHtml(value) + '"';
    }
  }

  return attrs;
}

/** What a caught error says. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Shown in place of a tab's content while it's never been loaded yet (first visit, or right
// after a hard refresh of the page) — as opposed to ve-loading-indicator, which is for a
// background reload of a tab that already has cached content on screen.
export function renderSkeleton(): string {
  let rows = '';

  for (let i = 0; i < 5; i++) {
    rows += '<div class="ve-skeleton-row"></div>';
  }

  return '<div class="ve-skeleton">' + rows + '</div>';
}

// A plain string entry uses itself as both id and text; an object entry may carry either/both —
// shared by the tag-level static option list and each list-column's own "options" (see
// listItemFieldsHtml()), since both follow the same { id, text } | string shape.
export function normalizeOptionEntry(o: OptionEntry): NormalizedOption {
  return typeof o === 'string'
    ? { id: o, text: o }
    : { id: String(o.id), text: String(o.text != null ? o.text : o.id) };
}

export function sourceBadgeHtml(source: string | null | undefined): string {
  if (!source) {
    return '';
  }

  const kind = String(source).toLowerCase();
  const extra = kind === 'dataset' ? ' badge-source-dataset' : kind === 'static' ? ' badge-source-static' : '';

  return '<span class="badge' + extra + '">' + escapeHtml(source) + '</span>';
}

export function typeBadgeHtml(type: string | null | undefined): string {
  if (!type) {
    return '';
  }

  return '<span class="badge">' + escapeHtml(type) + '</span>';
}
