/**
 * Dependency-free word-level diff for the playground output comparison
 * (U03 "green/red character diffs", implemented at word granularity so
 * highlights stay readable on prose/JSON outputs).
 *
 * Classic LCS over word tokens, O(n·m); inputs are capped so a huge
 * output degrades to "everything differs" instead of freezing the tab.
 */

export type DiffSegment = {
  text: string;
  /** same = in both; removed = only in base; added = only in candidate. */
  kind: "same" | "removed" | "added";
};

const MAX_TOKENS = 1200;

/** Split keeping whitespace as its own tokens so joins are lossless. */
function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t.length > 0);
}

/** Merge adjacent segments of the same kind. */
function compact(segments: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (const seg of segments) {
    if (!seg.text) continue;
    const last = out[out.length - 1];
    if (last && last.kind === seg.kind) last.text += seg.text;
    else out.push({ ...seg });
  }
  return out;
}

/**
 * Diff `base` against `candidate`. Segments come back in display order
 * for a single inline view: shared text, then removals (base-only),
 * then additions (candidate-only), interleaved along the LCS walk.
 */
export function diffWords(base: string, candidate: string): DiffSegment[] {
  if (base === candidate) {
    return base ? [{ text: base, kind: "same" }] : [];
  }
  const a = tokenize(base);
  const b = tokenize(candidate);
  if (a.length === 0) return compact([{ text: candidate, kind: "added" }]);
  if (b.length === 0) return compact([{ text: base, kind: "removed" }]);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    // Too big for O(n·m) — degrade to a whole-string swap.
    return compact([
      { text: base, kind: "removed" },
      { text: candidate, kind: "added" },
    ]);
  }

  // LCS table (single-allocation, row-major Uint32).
  const cols = b.length + 1;
  const table = new Uint32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }

  const segments: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      segments.push({ text: a[i], kind: "same" });
      i++;
      j++;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      segments.push({ text: a[i], kind: "removed" });
      i++;
    } else {
      segments.push({ text: b[j], kind: "added" });
      j++;
    }
  }
  while (i < a.length) segments.push({ text: a[i++], kind: "removed" });
  while (j < b.length) segments.push({ text: b[j++], kind: "added" });
  return compact(segments);
}
