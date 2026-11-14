/**
 * D1850: how a text was rewritten, as pieces, so what a later pass removed can be traced back to the original text
 * by intervals instead of a map per character. A rewrite (the gating, a token pass, the assignment pass) replaces
 * ranges of its input by the sentinel; the output is then pieces in order, each either a run of the input (`from` its
 * start there) or a sentinel (`from` -1). The composer works on these and on sorted, merged intervals, so its cost
 * follows the number of findings, not the length of the text (a megabyte of mixed text holding one excused value
 * paid 20 ms for masks over every character).
 */

/** `[start, end)`. */
export type Iv = [number, number];

/** Pieces of an output: `[outStart, outEnd, from]` flattened, `from` -1 for a sentinel. */
export type Pieces = number[];

/** The pieces of the identity rewrite of a text `length` long. */
export const identity = (length: number): Pieces => (length > 0 ? [0, length, 0] : []);

/**
 * The pieces of `cur` after `ranges` of it (sorted, apart, none empty) are each replaced by a sentinel `sentinel` long, given
 * `pieces`, the pieces of `cur` against the original. Kept runs keep their origin; a replaced range becomes one
 * sentinel piece.
 */
export function replaced(pieces: Pieces, ranges: Iv[], sentinel: number): Pieces {
  const out: Pieces = [];
  let shift = 0; // output offset minus input offset, so far
  let r = 0;
  for (let p = 0; p < pieces.length; p += 3) {
    let s = pieces[p]!;
    const e = pieces[p + 1]!;
    const from = pieces[p + 2]!;
    while (s < e) {
      // Skip ranges that end before this point.
      while (r < ranges.length && ranges[r]![1] <= s) r++;
      const range = ranges[r];
      if (!range || range[0] >= e) {
        push(out, s + shift, e + shift, from < 0 ? -1 : from + (s - pieces[p]!));
        s = e;
      } else if (range[0] > s) {
        push(out, s + shift, range[0] + shift, from < 0 ? -1 : from + (s - pieces[p]!));
        s = range[0];
      } else {
        // `s` is inside the range: the range's sentinel is emitted once, at its start.
        if (s === range[0]) {
          push(out, s + shift, s + shift + sentinel, -1);
          shift += sentinel - (range[1] - range[0]);
        }
        s = Math.min(e, range[1]);
        if (s === range[1]) r++;
      }
    }
  }
  return out;
}

function push(out: Pieces, start: number, end: number, from: number): void {
  if (end <= start) return;
  out.push(start, end, from);
}

/** `ivs` (sorted intervals of an output) traced back to the original through `pieces`: sorted, merged. */
export function traced(pieces: Pieces, ivs: Iv[]): Iv[] {
  const out: Iv[] = [];
  let p = 0;
  for (const [a, b] of ivs) {
    while (p < pieces.length && pieces[p + 1]! <= a) p += 3;
    for (let q = p; q < pieces.length && pieces[q]! < b; q += 3) {
      const from = pieces[q + 2]!;
      if (from < 0) continue;
      const s = Math.max(a, pieces[q]!);
      const e = Math.min(b, pieces[q + 1]!);
      if (e > s) add(out, from + (s - pieces[q]!), from + (e - pieces[q]!));
    }
  }
  return out;
}

/** Appends `[s, e)` to sorted merged `out` (s at or after the last start). */
function add(out: Iv[], s: number, e: number): void {
  const last = out[out.length - 1];
  if (last && s <= last[1]) {
    if (e > last[1]) last[1] = e;
  } else out.push([s, e]);
}

/** The union of interval lists, sorted and merged. */
export function union(...lists: Iv[][]): Iv[] {
  const all: Iv[] = [];
  for (const list of lists) for (const iv of list) if (iv[1] > iv[0]) all.push(iv);
  all.sort((x, y) => x[0] - y[0]);
  const out: Iv[] = [];
  for (const [s, e] of all) add(out, s, e);
  return out;
}

/** Whether two sorted merged interval lists are equal. */
export function same(a: Iv[], b: Iv[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]![0] !== b[i]![0] || a[i]![1] !== b[i]![1]) return false;
  return true;
}

/** A mask (1: in an interval) of a text `length` long. */
export function maskOf(ivs: Iv[], length: number): Uint8Array {
  const mask = new Uint8Array(length);
  for (const [s, e] of ivs) mask.fill(1, s, e);
  return mask;
}

/** The runs of 1 in `mask`, as sorted merged intervals. */
export function runsOf(mask: Uint8Array): Iv[] {
  const out: Iv[] = [];
  for (let i = 0; i < mask.length;) {
    if (mask[i] === 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < mask.length && mask[j] === 1) j++;
    out.push([i, j]);
    i = j;
  }
  return out;
}
