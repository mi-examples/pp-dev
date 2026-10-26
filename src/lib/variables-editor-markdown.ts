/**
 * Markdown for page variable descriptions in the Variables Editor's Values tab. MI renders them
 * with showdown's default options (see MI's `PageVariable.tsx`); this is the subset that matters
 * there, rendered the same way:
 *
 * - `**bold**` and `__bold__`, `*italic*` and `_italic_` (not inside words, like `snake_case`);
 * - inline code with one or more backticks (``` `` a `b` `` ```), and fenced ```` ``` ```` blocks;
 * - `-`, `*`, `+` and `1.` lists;
 * - underline and strikethrough the way showdown lets them through: as `<u>`, `<s>`, `<del>` and
 *   `<strike>` tags. (Showdown's defaults don't turn `~~text~~` into strikethrough.)
 *
 * Everything else is escaped, so a description can't inject markup. Line breaks are kept, as the
 * plain-text hint did before.
 *
 * It runs in the editor page's script, so it is plain JavaScript in a string; `String.raw` keeps
 * the regular expressions' backslashes as they are.
 */
export const DESCRIPTION_MARKDOWN_SCRIPT = String.raw`
function renderDescriptionMarkdown(text) {
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const inline = (line) => {
    const codes = [];
    // Code spans first, so nothing inside them is formatted: a whole run of backticks up to the
    // same run. Mismatched runs stay as they are.
    let out = line.replace(/(?<!\x60)(\x60+)([^\x60]|[^\x60][\s\S]*?[^\x60])\1(?!\x60)/g, (_, ticks, code) => {
      codes.push('<code>' + escape(code.replace(/\n/g, ' ').trim()) + '</code>');

      return '\u0000' + (codes.length - 1) + '\u0000';
    });

    out = escape(out)
      .replace(/&lt;(\/?)(u|s|del|strike)&gt;/gi, '<$1$2>')
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?=[^\w]|$)/g, '$1<strong>$2</strong>')
      .replace(/\*(?=\S)([\s\S]*?\S)\*/g, '<em>$1</em>')
      .replace(/(^|[^\w])_(?=\S)([\s\S]*?\S)_(?=[^\w]|$)/g, '$1<em>$2</em>');

    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
  };

  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      // One paragraph at a time, so code and emphasis can span its line breaks, which stay.
      blocks.push('<p>' + inline(paragraph.join('\n')).replace(/\n/g, '<br>') + '</p>');
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      // A numbered list goes on from the number its first item has: "2." after a blank line is 2.
      const start = list.start && list.start !== 1 ? ' start="' + list.start + '"' : '';

      blocks.push('<' + list.tag + start + '>' + list.items.map((item) => '<li>' + inline(item) + '</li>').join('') + '</' + list.tag + '>');
      list = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // An opening fence: three or more backticks and an info string without any (a line with three
    // backticks, "a", three backticks again is inline code instead).
    const fence = /^\s*(\x60{3,})[^\x60]*$/.exec(line);

    if (fence) {
      flushParagraph();
      flushList();

      const code = [];

      // Closed by a line of only backticks, at least as many as opened it.
      const close = new RegExp('^\\s*\\x60{' + fence[1].length + ',}\\s*$');

      for (i++; i < lines.length && !close.test(lines[i]); i++) {
        code.push(lines[i]);
      }

      blocks.push('<pre><code>' + escape(code.join('\n')) + '</code></pre>');
      continue;
    }

    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);

    if (item) {
      const tag = item[1] ? 'ul' : 'ol';

      flushParagraph();

      if (list && list.tag !== tag) { flushList(); }

      list = list || { tag, items: [], start: item[2] ? Number(item[2]) : undefined };
      list.items.push(item[3]);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    // A line right after a list item, indented, continues it.
    if (list && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1] += ' ' + line.trim();
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();

  return blocks.join('');
}
`;
