// The Variables Editor's dialogs: custom HTML modals instead of window.prompt()/confirm() — some
// embedded webviews (e.g. Cursor's built-in browser) don't implement those native dialogs at all,
// so they just return null immediately with no dialog ever shown. These work identically everywhere.
import { escapeHtml } from './html.js';
import { computeLineDiff } from './line-diff.js';

/** Appends a `.ve-modal-overlay` with `html` inside to the page. */
function openOverlay(html: string): HTMLDivElement {
  const overlay = document.createElement('div');

  overlay.className = 've-modal-overlay';
  overlay.innerHTML = html;
  document.body.appendChild(overlay);

  return overlay;
}

const find = <T extends HTMLElement = HTMLButtonElement>(root: ParentNode, selector: string) =>
  root.querySelector(selector) as T;

// Asks for a value (in place of window.prompt()); `onDone` gets `null` when the user cancels.
export function showCustomValueModal(title: string, initialValue: string, onDone: (value: string | null) => void) {
  const overlay = openOverlay(
    '<div class="ve-modal">' +
      '<div class="ve-modal-title">' +
      escapeHtml(title) +
      '</div>' +
      '<input type="text" class="ve-modal-input" value="' +
      escapeHtml(initialValue) +
      '" />' +
      '<div class="ve-modal-actions">' +
      '<button type="button" class="btn btn-sm ve-modal-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-sm btn-primary ve-modal-ok">OK</button>' +
      '</div>' +
      '</div>',
  );
  const inputEl = find<HTMLInputElement>(overlay, '.ve-modal-input');

  inputEl.focus();
  inputEl.select();

  function close(value: string | null) {
    overlay.remove();
    onDone(value);
  }

  find(overlay, '.ve-modal-ok').addEventListener('click', () => close(inputEl.value));
  find(overlay, '.ve-modal-cancel').addEventListener('click', () => close(null));
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
export function showConfirmModal(message: string, onConfirm: () => void) {
  const overlay = openOverlay(
    '<div class="ve-modal">' +
      '<div class="ve-modal-title">' +
      escapeHtml(message) +
      '</div>' +
      '<div class="ve-modal-actions">' +
      '<button type="button" class="btn btn-sm ve-modal-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-sm btn-primary ve-modal-ok">OK</button>' +
      '</div>' +
      '</div>',
  );

  find(overlay, '.ve-modal-ok').focus();

  function close(confirmed: boolean) {
    overlay.remove();

    if (confirmed) {
      onConfirm();
    }
  }

  find(overlay, '.ve-modal-ok').addEventListener('click', () => close(true));
  find(overlay, '.ve-modal-cancel').addEventListener('click', () => close(false));
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
export function showInfoModal(title: string, bodyHtml: string) {
  const overlay = openOverlay(
    '<div class="ve-modal ve-modal-wide">' +
      '<div class="ve-modal-title">' +
      escapeHtml(title) +
      '</div>' +
      '<div class="ve-modal-body">' +
      bodyHtml +
      '</div>' +
      '<div class="ve-modal-actions">' +
      '<button type="button" class="btn btn-sm btn-primary ve-modal-ok">Close</button>' +
      '</div>' +
      '</div>',
  );

  find(overlay, '.ve-modal-ok').focus();

  function close() {
    overlay.remove();
  }

  find(overlay, '.ve-modal-ok').addEventListener('click', close);
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) {
      close();
    }
  });
  overlay.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  });
}

/** `text` as JSON with 2-space indentation, or as it is when it isn't JSON. */
export function normalizeJsonText(text: string | null | undefined): string {
  try {
    return JSON.stringify(JSON.parse(text as string), null, 2);
  } catch {
    return String(text || '');
  }
}

// A changed line with the part that differs from its pair (the line it replaced) highlighted.
function inlineDiffHtml(text: string, pair: string | undefined, mode: 'add' | 'remove'): string {
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

function renderJsonDiffHtml(beforeText: string, afterText: string): { html: string; changeCount: number } {
  const before = normalizeJsonText(beforeText);
  const after = normalizeJsonText(afterText);

  if (before === after) {
    return { html: '<div class="ve-diff-empty">No differences in the JSON file.</div>', changeCount: 0 };
  }

  const lines = computeLineDiff(before, after);
  let changeCount = 0;
  let inHunk = false;

  const html =
    '<div class="ve-diff">' +
    lines
      .map((line) => {
        if (line.type === 'equal') {
          inHunk = false;

          return (
            '<div class="ve-diff-line"><span class="ve-diff-prefix"> </span><span>' +
            escapeHtml(line.text) +
            '</span></div>'
          );
        }

        const attrs = !inHunk ? ' data-change-index="' + changeCount + '"' : '';

        if (!inHunk) {
          changeCount++;
          inHunk = true;
        }

        if (line.type === 'remove') {
          return (
            '<div class="ve-diff-line is-remove"' +
            attrs +
            '><span class="ve-diff-prefix">-</span><span>' +
            inlineDiffHtml(line.text, line.pair, 'remove') +
            '</span></div>'
          );
        }

        return (
          '<div class="ve-diff-line is-add"' +
          attrs +
          '><span class="ve-diff-prefix">+</span><span>' +
          inlineDiffHtml(line.text, line.pair, 'add') +
          '</span></div>'
        );
      })
      .join('') +
    '</div>';

  return { html: html, changeCount: changeCount };
}

// The save confirmation: the JSON file's changes, GitHub-style, with ←/→ to step through them.
export function showJsonDiffModal(beforeText: string, afterText: string, onConfirm: () => void) {
  const diff = renderJsonDiffHtml(beforeText, afterText);
  const hasChanges = diff.changeCount > 0;
  const overlay = openOverlay(
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
          '<span class="ve-diff-nav-count">1 / ' +
          diff.changeCount +
          '</span>' +
          '</div>'
        : '') +
      diff.html +
      '</div>' +
      '<div class="ve-modal-actions">' +
      '<div class="hint">Review added (+) and removed (−) lines, including inline highlights for changed segments.</div>' +
      '<button type="button" class="btn btn-sm ve-modal-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-sm btn-primary ve-modal-ok">Save Changes</button>' +
      '</div>' +
      '</div>',
  );

  find(overlay, '.ve-modal-ok').focus();

  let currentChange = 0;

  function updateChangeNav() {
    const countEl = overlay.querySelector('.ve-diff-nav-count');
    const prevBtn = overlay.querySelector<HTMLButtonElement>('.ve-diff-prev');
    const nextBtn = overlay.querySelector<HTMLButtonElement>('.ve-diff-next');
    const diffEl = overlay.querySelector('.ve-diff');

    if (!hasChanges || !diffEl) {
      return;
    }

    diffEl.querySelectorAll('.ve-diff-line.is-current-change').forEach((el) => {
      el.classList.remove('is-current-change');
    });

    const target = diffEl.querySelector('.ve-diff-line[data-change-index="' + currentChange + '"]');

    if (target) {
      target.classList.add('is-current-change');
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    if (countEl) {
      countEl.textContent = currentChange + 1 + ' / ' + diff.changeCount;
    }

    if (prevBtn) {
      prevBtn.disabled = currentChange <= 0;
    }

    if (nextBtn) {
      nextBtn.disabled = currentChange >= diff.changeCount - 1;
    }
  }

  if (hasChanges) {
    find(overlay, '.ve-diff-prev').addEventListener('click', function () {
      if (currentChange > 0) {
        currentChange--;
        updateChangeNav();
      }
    });
    find(overlay, '.ve-diff-next').addEventListener('click', function () {
      if (currentChange < diff.changeCount - 1) {
        currentChange++;
        updateChangeNav();
      }
    });

    // Wait a frame so the modal layout is ready before scrolling.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () {
        updateChangeNav();
      });
    }
  }

  function close(confirmed: boolean) {
    overlay.remove();

    if (confirmed && typeof onConfirm === 'function') {
      onConfirm();
    }
  }

  find(overlay, '.ve-modal-ok').addEventListener('click', () => close(true));
  find(overlay, '.ve-modal-cancel').addEventListener('click', () => close(false));
  find(overlay, '.ve-modal-close').addEventListener('click', () => close(false));
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) {
      close(false);
    }
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
