import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeSvgFilesInDir, normalizeSvgLikeMi } from '../../../src/lib/helpers/svg-mi-normalize.helper.js';

// Every "expected" string below is the exact byte content a real MI instance (stg7x) returned
// after uploading the matching "input" (verified in PP-4123). MI re-serializes every SVG it
// stores — locally reproducing that transform is what keeps the build's VERSION.json hash from
// perpetually mismatching what MI actually ends up storing.
describe('normalizeSvgLikeMi', () => {
  it('matches MI exactly for an SVGO-minified icon (self-closing tags, nested defs/clipPath)', () => {
    const input =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 16 16"><g clip-path="url(#clip0_219_4498)"><path fill="#78909c" d="M8.08325 0.333374H7.58325V3.33337H8.08325V0.333374Z"/><path fill="#5c6bc0" d="M14.0833 6.33337H13.5833V9.33337H14.0833V6.33337Z"/></g><defs><clipPath id="clip0_219_4498"><path fill="#fff" d="M0 0H16V16H0z"/></clipPath></defs></svg>';

    const expected =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 16 16">\n' +
      '  <g clip-path="url(#clip0_219_4498)">\n' +
      '    <path fill="#78909c" d="M8.08325 0.333374H7.58325V3.33337H8.08325V0.333374Z"></path>\n' +
      '    <path fill="#5c6bc0" d="M14.0833 6.33337H13.5833V9.33337H14.0833V6.33337Z"></path>\n' +
      '  </g>\n' +
      '  <defs>\n' +
      '    <clipPath id="clip0_219_4498">\n' +
      '      <path fill="#fff" d="M0 0H16V16H0z"></path>\n' +
      '    </clipPath>\n' +
      '  </defs>\n' +
      '</svg>\n';

    expect(normalizeSvgLikeMi(input)).toBe(expected);
  });

  it('matches MI exactly for a hand-authored icon (comments, non-standard attribute order, mixed self-closing)', () => {
    const input = [
      '<svg viewBox="0 0 10 10" width="10" fill="none" height="10" xmlns="http://www.w3.org/2000/svg">',
      '<rect y="1" x="1" width="8" fill="#123456" height="8" />',
      '<!-- a comment to see if MI keeps it -->',
      '<circle r="3" cy="5" cx="5" fill="#abcdef"/>',
      '</svg>',
    ].join('\n');

    const expected =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" fill="none" height="10">\n' +
      '  <rect y="1" x="1" width="8" fill="#123456" height="8"></rect>\n' +
      '  <circle r="3" cy="5" cx="5" fill="#abcdef"></circle>\n' +
      '</svg>\n';

    expect(normalizeSvgLikeMi(input)).toBe(expected);
  });

  it('hoists every xmlns:* declaration to the front, in their own relative order, without touching xlink:href on descendants', () => {
    const input =
      '<svg width="8" xmlns:xlink="http://www.w3.org/1999/xlink" height="8" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><use xlink:href="#a" transform="scale(2)"/></svg>';

    const normalized = normalizeSvgLikeMi(input);

    expect(normalized).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<svg xmlns:xlink="http://www.w3.org/1999/xlink" xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8">\n' +
        '  <use xlink:href="#a" transform="scale(2)"></use>\n' +
        '</svg>\n',
    );
  });

  it('is idempotent — normalizing an already-normalized SVG returns it unchanged', () => {
    const once = normalizeSvgLikeMi('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');

    expect(normalizeSvgLikeMi(once)).toBe(once);
  });

  it('leaves text-bearing elements untouched instead of corrupting rendered text', () => {
    const input = '<svg xmlns="http://www.w3.org/2000/svg"><text x="0" y="0">Hello <tspan>World</tspan></text></svg>';

    expect(normalizeSvgLikeMi(input)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<svg xmlns="http://www.w3.org/2000/svg">\n' +
        '  <text x="0" y="0">Hello <tspan>World</tspan></text>\n' +
        '</svg>\n',
    );
  });

  it('returns non-SVG content unchanged', () => {
    expect(normalizeSvgLikeMi('not an svg at all')).toBe('not an svg at all');
  });
});

describe('normalizeSvgFilesInDir', () => {
  it('normalizes every .svg file found recursively, and leaves other files untouched', () => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'pp-dev-svg-normalize-'));

    try {
      mkdirSync(path.join(testDir, 'nested'), { recursive: true });
      writeFileSync(
        path.join(testDir, 'icon.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
      );
      writeFileSync(
        path.join(testDir, 'nested', 'other.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>',
      );
      writeFileSync(path.join(testDir, 'readme.txt'), 'not svg, leave me alone');

      normalizeSvgFilesInDir(testDir);

      expect(readFileSync(path.join(testDir, 'icon.svg'), 'utf-8')).toBe(
        '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg">\n  <rect width="1" height="1"></rect>\n</svg>\n',
      );
      expect(readFileSync(path.join(testDir, 'nested', 'other.svg'), 'utf-8')).toBe(
        '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg">\n  <circle r="1"></circle>\n</svg>\n',
      );
      expect(readFileSync(path.join(testDir, 'readme.txt'), 'utf-8')).toBe('not svg, leave me alone');
    } finally {
      rmSync(testDir, { force: true, recursive: true });
    }
  });

  it('does not rewrite a file that is already in normalized form', () => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'pp-dev-svg-normalize-'));

    try {
      const already = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg">\n  <rect width="1" height="1"></rect>\n</svg>\n';

      writeFileSync(path.join(testDir, 'icon.svg'), already);

      normalizeSvgFilesInDir(testDir);

      expect(readFileSync(path.join(testDir, 'icon.svg'), 'utf-8')).toBe(already);
      expect(existsSync(path.join(testDir, 'icon.svg'))).toBe(true);
    } finally {
      rmSync(testDir, { force: true, recursive: true });
    }
  });
});
