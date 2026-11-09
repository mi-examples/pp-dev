// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { bindModalKeys } from '../../../src/client/variables-editor/modals.js';

/**
 * Tab within a Variables Editor dialog. The import picker hides the pages its filter leaves out
 * with `display: none`; counted as tab stops, a hidden last one let Tab leave the dialog, and
 * Shift+Tab tried to focus it.
 */
describe('bindModalKeys — Tab', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function open() {
    const overlay = document.createElement('div');

    overlay.className = 've-modal-overlay';
    overlay.innerHTML =
      '<button id="close">Close</button>' +
      '<button id="a">A</button>' +
      '<div style="display: none"><button id="hidden-by-parent">B</button></div>' +
      '<button id="hidden" hidden>C</button>' +
      '<button id="invisible" style="visibility: hidden">D</button>';
    document.body.appendChild(overlay);

    const unbind = bindModalKeys(overlay, () => {});
    const tab = (shiftKey = false) =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }));
    const focus = (id: string) => document.getElementById(id)!.focus();

    return { unbind, tab, focus };
  }

  it('wraps from the last visible control to the first', () => {
    const { unbind, tab, focus } = open();

    focus('a');
    tab();

    expect(document.activeElement?.id).toBe('close');
    unbind();
  });

  it('wraps from the first control back to the last visible one', () => {
    const { unbind, tab, focus } = open();

    focus('close');
    tab(true);

    expect(document.activeElement?.id).toBe('a');
    unbind();
  });
});
