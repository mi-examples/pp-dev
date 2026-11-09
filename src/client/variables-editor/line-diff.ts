// Line diff of the JSON the Variables Editor is about to save, for its confirmation dialog.

export interface DiffLine {
  type: 'equal' | 'remove' | 'add';
  text: string;
  /** For a removed line followed by an added one: the other line, highlighted inline. */
  pair?: string;
}

function lcsLineMatrix(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  return dp;
}

export function computeLineDiff(
  beforeText: string | null | undefined,
  afterText: string | null | undefined,
): DiffLine[] {
  const before = String(beforeText || '').split('\n');
  const after = String(afterText || '').split('\n');
  // The lines both sides start and end with are equal: only what lies between goes through the
  // O(m·n) LCS table, which for two whole files (a few thousand lines each) took seconds before
  // the modal showed, for a change of a line or two.
  let start = 0;
  let endBefore = before.length;
  let endAfter = after.length;

  while (start < endBefore && start < endAfter && before[start] === after[start]) {
    start++;
  }

  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }

  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);
  const dp = lcsLineMatrix(a, b);
  const lines: DiffLine[] = before.slice(0, start).map((text) => ({ type: 'equal', text }));
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ type: 'equal', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: 'remove', text: a[i] });
      i++;
    } else {
      lines.push({ type: 'add', text: b[j] });
      j++;
    }
  }

  while (i < a.length) {
    lines.push({ type: 'remove', text: a[i++] });
  }

  while (j < b.length) {
    lines.push({ type: 'add', text: b[j++] });
  }

  for (const text of before.slice(endBefore)) {
    lines.push({ type: 'equal', text });
  }

  // Pair adjacent remove+add as inline-highlighted changes.
  const paired: DiffLine[] = [];

  for (let k = 0; k < lines.length; k++) {
    const cur = lines[k];
    const next = lines[k + 1];

    if (cur.type === 'remove' && next && next.type === 'add') {
      paired.push({ type: 'remove', text: cur.text, pair: next.text });
      paired.push({ type: 'add', text: next.text, pair: cur.text });
      k++;
    } else {
      paired.push(cur);
    }
  }

  return paired;
}
