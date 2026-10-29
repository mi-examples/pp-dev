import { describe, it, expect } from 'vitest';
import { renderDescriptionMarkdown as render } from '../../../src/client/variables-editor/markdown.js';

/** Markdown in page variable descriptions, the subset MI's showdown renders that matters there. */

describe('renderDescriptionMarkdown', () => {
  it('formats bold and italic both ways, but not inside words', () => {
    expect(render('**bold** __also__ *it* _too_ snake_case_name')).toBe(
      '<p><strong>bold</strong> <strong>also</strong> <em>it</em> <em>too</em> snake_case_name</p>',
    );
  });

  it('lets underline and strikethrough tags through, as showdown does, and escapes any other markup', () => {
    expect(render('<u>under</u> <s>gone</s> <del>old</del> <b onclick="x()">no</b> ~~kept~~')).toBe(
      '<p><u>under</u> <s>gone</s> <del>old</del> &lt;b onclick=&quot;x()&quot;&gt;no&lt;/b&gt; ~~kept~~</p>',
    );
  });

  it('renders inline code with one or more backticks, leaving what is inside alone', () => {
    expect(render('Use `**not bold**` or `` a `tick` here ``')).toBe(
      '<p>Use <code>**not bold**</code> or <code>a `tick` here</code></p>',
    );
  });

  it('renders fenced code blocks as they are', () => {
    expect(render('Example:\n```json\n{ "a": "<b>" }\n```\nAfter')).toBe(
      '<p>Example:</p><pre><code>{ &quot;a&quot;: &quot;&lt;b&gt;&quot; }</code></pre><p>After</p>',
    );
  });

  it('renders bulleted and numbered lists', () => {
    expect(render('Pick one:\n- **red**\n* green\n\n1. first\n2) second')).toBe(
      '<p>Pick one:</p><ul><li><strong>red</strong></li><li>green</li></ul><ol><li>first</li><li>second</li></ol>',
    );
  });

  it('leaves mismatched backtick runs as they are', () => {
    expect(render('Use ``code` here')).toBe('<p>Use ``code` here</p>');
  });

  it('keeps the numbers of a numbered list split by blank lines', () => {
    expect(render('1. Select a region\n\n2. Save the value')).toBe(
      '<ol><li>Select a region</li></ol><ol start="2"><li>Save the value</li></ol>',
    );
  });

  it('takes three backticks within a line for inline code, not a fence', () => {
    expect(render('```a``` first\nsecond')).toBe('<p><code>a</code> first<br>second</p>');
  });

  it('closes a fence only on a line of backticks alone', () => {
    expect(render('```\n```not-a-close\ncode\n```\nAfter')).toBe(
      '<pre><code>```not-a-close\ncode</code></pre><p>After</p>',
    );
  });

  it('lets code and emphasis span the line breaks of a paragraph', () => {
    expect(render('`first\nsecond` and **bold\nacross**')).toBe(
      '<p><code>first second</code> and <strong>bold<br>across</strong></p>',
    );
  });

  it('keeps line breaks within a paragraph, and separates paragraphs on a blank line', () => {
    expect(render('one\ntwo\n\nthree')).toBe('<p>one<br>two</p><p>three</p>');
  });
});
