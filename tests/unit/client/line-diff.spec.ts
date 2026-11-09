import { describe, it, expect } from 'vitest';
import { computeLineDiff } from '../../../src/client/variables-editor/line-diff.js';

/**
 * The diff the Variables Editor shows before a save. It ran the O(m·n) LCS table over both whole
 * files; the lines they share at the start and end now skip it.
 */
describe('computeLineDiff', () => {
  it('pairs a changed line, and keeps the lines around it', () => {
    expect(computeLineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { type: 'equal', text: 'a' },
      { type: 'remove', text: 'b', pair: 'B' },
      { type: 'add', text: 'B', pair: 'b' },
      { type: 'equal', text: 'c' },
    ]);
  });

  it('shows added and removed lines in the middle', () => {
    expect(computeLineDiff('a\nb\nc\nd', 'a\nc\nx\nd')).toEqual([
      { type: 'equal', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'equal', text: 'c' },
      { type: 'add', text: 'x' },
      { type: 'equal', text: 'd' },
    ]);
  });

  it('handles empty and identical texts', () => {
    expect(computeLineDiff('', 'a')).toEqual([
      { type: 'remove', text: '', pair: 'a' },
      { type: 'add', text: 'a', pair: '' },
    ]);
    expect(computeLineDiff('a\nb', 'a\nb')).toEqual([
      { type: 'equal', text: 'a' },
      { type: 'equal', text: 'b' },
    ]);
  });

  it('diffs two large files with a change in the middle at once', () => {
    const before = Array.from({ length: 20_000 }, (_, i) => `  "line ${i}": ${i},`);
    const after = [...before];

    after[10_000] = '  "changed": true,';

    // 20 000 × 20 000 cells was 400 million: seconds of a frozen tab, if not out of memory.
    const started = performance.now();
    const diff = computeLineDiff(before.join('\n'), after.join('\n'));

    expect(performance.now() - started).toBeLessThan(1000);
    expect(diff.filter((line) => line.type !== 'equal')).toEqual([
      { type: 'remove', text: '  "line 10000": 10000,', pair: '  "changed": true,' },
      { type: 'add', text: '  "changed": true,', pair: '  "line 10000": 10000,' },
    ]);
    expect(diff).toHaveLength(20_001);
  });
});
