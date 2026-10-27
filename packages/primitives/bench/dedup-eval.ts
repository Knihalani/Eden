/**
 * Scoring for the dedup benchmarks: line-level scores for quote strippers, pair-level precision and recall for
 * duplicate detectors, both against the labels `dedupCorpus` writes.
 */
import { L_FORWARD, L_HEADER, L_OWN, L_QUOTE, L_SIGNATURE, type Item } from "./dedup-corpus";

export interface StripScore {
  /** Own-text lines kept / own-text lines. */
  ownKept: number;
  /** Quote, header, forward and signature lines removed / such lines. */
  removed: number;
  /** Items with every own line kept and every removable line removed. */
  exact: number;
  items: number;
}

const removable = (label: number) =>
  label === L_QUOTE || label === L_HEADER || label === L_FORWARD || label === L_SIGNATURE;

/** Accumulates line-level scores; `kept[i]` says whether the stripper kept line i of `item.lines`. */
export class StripScorer {
  own = 0;
  ownKept = 0;
  rem = 0;
  remRemoved = 0;
  exact = 0;
  items = 0;

  add(item: Item, kept: boolean[]): void {
    const labels = item.labels!;
    let ok = true;
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i]!;
      if (label === L_OWN) {
        this.own++;
        if (kept[i]) this.ownKept++;
        else ok = false;
      } else if (removable(label)) {
        this.rem++;
        if (!kept[i]) this.remRemoved++;
        else ok = false;
      }
    }
    this.items++;
    if (ok) this.exact++;
  }

  score(): StripScore {
    return {
      ownKept: this.ownKept / Math.max(1, this.own),
      removed: this.remRemoved / Math.max(1, this.rem),
      exact: this.exact / Math.max(1, this.items),
      items: this.items,
    };
  }
}

/**
 * Which lines of `lines` a stripper kept, given only its output text: output lines are matched to input lines in
 * order by trimmed content (strippers keep a subset of lines, sometimes trimmed). Blank lines are ignored.
 */
export function keptLines(lines: string[], output: string): boolean[] {
  const kept = new Array<boolean>(lines.length).fill(false);
  const out = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let j = 0;
  for (let i = 0; i < lines.length && j < out.length; i++) {
    const t = lines[i]!.trim();
    if (t.length === 0) continue;
    if (t === out[j]) {
      kept[i] = true;
      j++;
    }
  }
  return kept;
}

export interface PairCounts {
  tp: number;
  fp: number;
  fn: number;
}

export function prf(c: PairCounts): string {
  const p = c.tp / Math.max(1, c.tp + c.fp);
  const r = c.tp / Math.max(1, c.tp + c.fn);
  const f = (2 * p * r) / Math.max(1e-9, p + r);
  return `P ${p.toFixed(3)}  R ${r.toFixed(3)}  F1 ${f.toFixed(3)}  (fp ${c.fp}, fn ${c.fn})`;
}

/**
 * Pair-level counts over all pairs of `items` for each named decision. `decide(i, j)` returns one boolean per name.
 * Also tallies false negatives by the kind of the later item and false positives by the pair of kinds.
 */
export function scorePairs(
  items: Item[],
  names: string[],
  decide: (i: number, j: number, out: boolean[]) => void,
): { counts: PairCounts[]; fnKinds: Map<string, number>[]; fpKinds: Map<string, number>[]; positives: number } {
  const counts = names.map(() => ({ tp: 0, fp: 0, fn: 0 }));
  const fnKinds = names.map(() => new Map<string, number>());
  const fpKinds = names.map(() => new Map<string, number>());
  const out = new Array<boolean>(names.length).fill(false);
  let positives = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const truth = items[i]!.group === items[j]!.group;
      if (truth) positives++;
      decide(i, j, out);
      for (let m = 0; m < names.length; m++) {
        const c = counts[m]!;
        if (out[m] && truth) c.tp++;
        else if (out[m]) {
          c.fp++;
          const k = [items[i]!.kind, items[j]!.kind].sort().join("/");
          fpKinds[m]!.set(k, (fpKinds[m]!.get(k) ?? 0) + 1);
        } else if (truth) {
          c.fn++;
          const k = items[j]!.kind;
          fnKinds[m]!.set(k, (fnKinds[m]!.get(k) ?? 0) + 1);
        }
      }
    }
  }
  return { counts, fnKinds, fpKinds, positives };
}

/** Exact Jaccard similarity of two sorted, de-duplicated arrays. */
export function jaccard(a: Uint32Array, b: Uint32Array): number {
  if (a.length === 0 && b.length === 0) return 1;
  let i = 0;
  let j = 0;
  let inter = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      inter++;
      i++;
      j++;
    } else if (a[i]! < b[j]!) i++;
    else j++;
  }
  return inter / (a.length + b.length - inter);
}

export function fmtKinds(m: Map<string, number>): string {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
}
