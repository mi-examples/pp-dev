// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { compile } from 'sass';

/**
 * The Variables Editor's stylesheet, applied to the markup of a schema row's details. Its labels
 * are MI's field names (`uid`, `tag_source`, `additional_options`); uppercased, they no longer
 * showed how a field is spelled.
 */
describe('Variables Editor styles', () => {
  beforeAll(() => {
    const { css } = compile(path.resolve(__dirname, '../../../src/client/variables-editor/variables-editor.scss'));

    document.head.innerHTML = `<style>${css}</style>`;
    document.body.innerHTML =
      '<div class="details-grid">' +
      '<div class="box-style"><label id="field">tag_source</label></div>' +
      '<label id="flag" class="checkbox-label"><input type="checkbox" />Use HTML editor</label>' +
      '</div>';
  });

  it('shows the field names in the schema details as written, in the code font', () => {
    const style = getComputedStyle(document.getElementById('field')!);

    expect(style.textTransform).not.toBe('uppercase');
    expect(style.fontFamily).toBe('var(--font-mono)');
  });

  it('keeps the editor flag checkboxes in the UI font', () => {
    const style = getComputedStyle(document.getElementById('flag')!);

    expect(style.textTransform).not.toBe('uppercase');
    expect(style.fontFamily).toBe('var(--font-ui)');
  });
});
