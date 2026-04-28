/**
 * Tiny line-level diff for the article-history viewer.
 *
 * Why hand-rolled and not `diff-match-patch`:
 *   We need 2-pane "removed / added" output for the UI, not patch
 *   format. Article bodies are short markdown — line-level diff is
 *   plenty. The classic Hunt-McIlroy LCS via dynamic programming
 *   runs in O(n×m) time and space; for typical 100-1000 line
 *   articles it's effectively instant. Adding a 30 KB dependency for
 *   this would be silly.
 */
export type DiffOp =
  | { kind: "equal"; line: string }
  | { kind: "del"; line: string }
  | { kind: "add"; line: string };

export function diffLines(before: string, after: string): DiffOp[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;

  // Build LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    Array(m + 1).fill(0),
  );
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      lcs[i + 1]![j + 1] =
        a[i] === b[j]
          ? lcs[i]![j]! + 1
          : Math.max(lcs[i]![j + 1]!, lcs[i + 1]![j]!);
    }
  }

  // Walk back to produce the diff.
  const ops: DiffOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ kind: "equal", line: a[i - 1]! });
      i--;
      j--;
    } else if (lcs[i - 1]![j]! >= lcs[i]![j - 1]!) {
      ops.push({ kind: "del", line: a[i - 1]! });
      i--;
    } else {
      ops.push({ kind: "add", line: b[j - 1]! });
      j--;
    }
  }
  while (i > 0) {
    ops.push({ kind: "del", line: a[i - 1]! });
    i--;
  }
  while (j > 0) {
    ops.push({ kind: "add", line: b[j - 1]! });
    j--;
  }
  return ops.reverse();
}
