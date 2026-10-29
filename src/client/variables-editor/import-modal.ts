// The HTML of the Values tab's "Import from page…" dialog: a page picker, then the review of what
// that page's values would change. editor.ts loads the data and handles the `data-action`s.
import { actionAttrs, escapeHtml, typeBadgeHtml } from './html.js';
import type { ImportCandidate, ImportPage, ImportPlan } from './types.js';

const closeButtonHtml =
  '<button type="button" class="btn btn-sm ve-modal-close" title="Close" aria-label="Close"' +
  actionAttrs('close-import-modal') +
  '>✕</button>';

/** The picker step, its body loading. */
export function importPickerStepHtml(): string {
  return (
    '<div class="ve-modal ve-modal-wide" role="dialog" aria-modal="true">' +
    '<div class="ve-modal-title-row">' +
    '<div class="ve-modal-title">Import values from another page</div>' +
    closeButtonHtml +
    '</div>' +
    '<div class="ve-modal-body"><span class="ve-loading-indicator"><span class="ve-loading-dot"></span>Loading pages…</span></div>' +
    '</div>'
  );
}

/** The review step of a page, its body loading. */
export function importReviewStepHtml(pageName: string): string {
  return (
    '<div class="ve-modal ve-modal-wide" role="dialog" aria-modal="true">' +
    '<div class="ve-modal-title-row">' +
    '<div style="flex:1;min-width:0">' +
    '<button type="button" class="ve-modal-back"' +
    actionAttrs('back-to-import-picker') +
    '>← Back</button>' +
    '<div class="ve-modal-title" style="margin-bottom:0">Import values from "' +
    escapeHtml(pageName) +
    '"</div>' +
    '</div>' +
    closeButtonHtml +
    '</div>' +
    '<div class="ve-modal-body"><span class="ve-loading-indicator"><span class="ve-loading-dot"></span>Loading values…</span></div>' +
    '<div class="ve-modal-actions" id="ve-import-actions"></div>' +
    '</div>'
  );
}

export function importErrorHtml(message: string): string {
  return '<div class="hint" style="color:var(--red)">' + escapeHtml(message) + '</div>';
}

export function importPickerBodyHtml(pages: ImportPage[]): string {
  if (!pages.length) {
    return '<div class="ve-import-empty">No other pages found on this instance.</div>';
  }

  const sameTemplate = pages.filter((p) => p.sameTemplate);
  const other = pages.filter((p) => !p.sameTemplate);

  return (
    '<div class="ve-import-search"><input type="text" id="ve-import-filter" placeholder="Filter pages…"' +
    actionAttrs('filter-import-pages') +
    ' autocomplete="off" /></div>' +
    importPageGroupHtml('Pages using this template', sameTemplate) +
    importPageGroupHtml('Other pages', other) +
    '<div class="ve-import-empty" id="ve-import-page-empty" style="display:none">No pages match your filter.</div>'
  );
}

function importPageGroupHtml(title: string, pages: ImportPage[]): string {
  if (!pages.length) {
    return '';
  }

  const rows = pages
    .map(
      (p) =>
        '<button type="button" class="ve-import-page-row" data-search="' +
        escapeHtml((p.name + ' ' + p.internal_name).toLowerCase()) +
        '"' +
        actionAttrs('select-import-page', { pageId: p.id, pageName: p.name }) +
        '>' +
        '<span class="ve-import-page-name">' +
        escapeHtml(p.name) +
        '</span>' +
        '<span class="ve-import-page-slug">' +
        escapeHtml(p.internal_name) +
        '</span>' +
        '</button>',
    )
    .join('');

  return (
    '<div class="ve-import-page-group">' +
    '<div class="ve-import-section-title">' +
    escapeHtml(title) +
    '</div>' +
    '<div class="ve-import-page-list">' +
    rows +
    '</div>' +
    '</div>'
  );
}

export function importReviewBodyHtml(plan: ImportPlan): string {
  const importable = plan.importable || [];
  const skipped = plan.skipped || [];

  if (!importable.length && !skipped.length) {
    return '<div class="ve-import-empty">This page has no live variable values to import.</div>';
  }

  let html = '';

  if (importable.length) {
    html +=
      '<div class="ve-import-list-head">' +
      '<span class="badge">Importable (' +
      importable.length +
      ')</span>' +
      '<label class="ve-import-select-all"><input type="checkbox" id="ve-import-select-all" checked' +
      actionAttrs('toggle-import-all') +
      ' /> select all</label>' +
      '</div>' +
      '<div class="ve-import-list">' +
      importable.map((c, i) => importRowHtml(c, i)).join('') +
      '</div>';
  } else {
    html += '<div class="hint">Nothing on this page matches a variable name in the current schema.</div>';
  }

  if (skipped.length) {
    html +=
      '<div class="ve-import-section-title">Skipped (' +
      skipped.length +
      ')</div>' +
      '<div class="ve-import-list">' +
      skipped
        .map(
          (s) =>
            '<div class="ve-import-skip-row">' +
            '<span class="ve-import-row-name">' +
            escapeHtml(s.name) +
            '</span>' +
            '<span class="ve-import-skip-reason">' +
            escapeHtml(s.reason) +
            '</span>' +
            '</div>',
        )
        .join('') +
      '</div>';
  }

  return html;
}

function importRowHtml(candidate: ImportCandidate, i: number): string {
  return (
    '<label class="ve-import-row">' +
    '<input type="checkbox" class="ve-import-check" data-index="' +
    i +
    '" checked' +
    actionAttrs('update-import-count') +
    ' />' +
    '<span class="ve-import-row-main">' +
    '<span class="ve-import-row-top"><span class="ve-import-row-name">' +
    escapeHtml(candidate.name) +
    '</span>' +
    typeBadgeHtml(candidate.tagType) +
    '</span>' +
    '<span class="ve-import-row-value">' +
    importValuePreviewHtml(candidate) +
    '</span>' +
    '</span>' +
    '</label>'
  );
}

function importValuePreviewHtml(candidate: ImportCandidate): string {
  const raw = candidate.sourceValue || '';

  if (candidate.tagType === 'color' && /^#[0-9a-fA-F]{3,8}$/.test(raw)) {
    return '<span class="ve-import-swatch" style="background:' + raw + '"></span>' + escapeHtml(raw);
  }

  const preview = raw.length > 80 ? raw.slice(0, 80) + '…' : raw;

  return escapeHtml(preview || '(empty)');
}

export function importReviewActionsHtml(plan: ImportPlan): string {
  const count = (plan.importable || []).length;
  const close = actionAttrs('close-import-modal');

  if (!count) {
    return '<button type="button" class="btn btn-sm"' + close + '>Close</button>';
  }

  return (
    '<span class="hint" id="ve-import-count" style="margin-right:auto">' +
    count +
    ' of ' +
    count +
    ' selected</span>' +
    '<button type="button" class="btn btn-sm"' +
    close +
    '>Cancel</button>' +
    '<button type="button" class="btn btn-sm btn-primary" id="ve-import-apply-btn"' +
    actionAttrs('apply-import-plan') +
    '>Apply ' +
    count +
    ' selected</button>'
  );
}
