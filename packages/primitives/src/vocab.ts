/**
 * A string interner: term ↔ dense integer id, so indexes, sets and counters work on Uint32Arrays instead of strings.
 *
 * Identity is a fingerprint, two 32-bit lanes (`termHash`) plus the folded length, with no character comparison.
 * Lane one is FNV-1a; lane two is an xor-multiply with a different multiplier and a rotation each step, so its low
 * bits depend on every input bit (without the rotation, the low k bits of both lanes depend only on the low k bits of
 * the characters, and the pair is weaker than 64 bits). Not a proven 64-bit hash: collisions are very unlikely but
 * not quantified here; one would merge two terms' postings, never crash. Measured on a 2 KB email (298 terms), scan
 * plus intern took 17.15 µs comparing against string objects, 15.31 µs against a character arena, and 6.30 µs with
 * the fingerprint (bench/vocab.bench.ts; docs/research/primitives.md).
 *
 * The *Range methods take a range of a larger string whose hash the caller computed while scanning (the tokenizer
 * does), so a known term allocates nothing. Keys are folded (lowercase, accents dropped: "Zoë" and "zoe" are one
 * term); the length that identifies a term is its folded length, which the caller passes.
 */

import { FOLD, FOLD_DROP, FOLD_EXPAND, foldOf, foldString } from "./charclass";

/**
 * The two hash lanes over `s[start, end)`, folded per character (FOLD: lowercase, accents dropped). Returns false if
 * a character expands when folded (a ligature); the caller then folds the whole string with `foldString` first.
 */
export function termHash(s: string, start: number, end: number, out: Uint32Array): boolean {
  let h = 0x811c9dc5 | 0;
  let g = 0x9747b28c | 0;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    const f = c < 128 ? FOLD[c]! : foldOf(c);
    if (f === FOLD_DROP) continue;
    if (f === FOLD_EXPAND) return false;
    h = Math.imul(h ^ f, 0x01000193);
    g = Math.imul(g ^ f, 0x5bd1e995);
    g = (g << 15) | (g >>> 17);
  }
  out[0] = h;
  out[1] = g;
  return true;
}

/** Folds `term` and hashes it into `out`; returns the folded term. */
function hashTerm(term: string, out: Uint32Array): string {
  if (termHash(term, 0, term.length, out)) return term;
  const folded = foldString(term);
  termHash(folded, 0, folded.length, out);
  return folded;
}

const scratch = new Uint32Array(2);

export class Vocab {
  private slots: Int32Array;
  private mask: number;
  private h1: Uint32Array;
  private h2: Uint32Array;
  private lens: Uint32Array;
  private readonly strings: string[] = [];

  constructor(capacity = 1_024) {
    const size = 1 << Math.ceil(Math.log2(Math.max(16, capacity * 2)));
    this.slots = new Int32Array(size);
    this.mask = size - 1;
    const ids = Math.max(16, capacity);
    this.h1 = new Uint32Array(ids);
    this.h2 = new Uint32Array(ids);
    this.lens = new Uint32Array(ids);
  }

  get size(): number {
    return this.strings.length;
  }

  /** The (folded) term for an id. */
  term(id: number): string {
    return this.strings[id]!;
  }

  /** The id of a term (folded first), or -1. */
  lookup(term: string): number {
    const folded = hashTerm(term, scratch);
    return this.find(scratch[0]!, scratch[1]!, foldedLength(folded));
  }

  /** The id of a term (folded first), adding it if new. */
  intern(term: string): number {
    const folded = hashTerm(term, scratch);
    const h = scratch[0]!;
    const g = scratch[1]!;
    const len = foldedLength(folded);
    const id = this.find(h, g, len);
    return id >= 0 ? id : this.add(foldString(folded), h, g, len);
  }

  /** The id of a folded term of length `len` whose lanes are `h`, `g` (as `termHash` computes them), or -1. */
  lookupRange(h: number, g: number, len: number): number {
    return this.find(h >>> 0, g >>> 0, len);
  }

  /** As `lookupRange`, adding `s[start, end)` (folded) if new. */
  internRange(s: string, start: number, end: number, h: number, g: number, len: number): number {
    const id = this.find(h >>> 0, g >>> 0, len);
    return id >= 0 ? id : this.add(foldString(s.slice(start, end)), h >>> 0, g >>> 0, len);
  }

  private find(h: number, g: number, len: number): number {
    const slots = this.slots;
    const mask = this.mask;
    for (let i = h & mask; ; i = (i + 1) & mask) {
      const v = slots[i]!;
      if (v === 0) return -1;
      const id = v - 1;
      if (this.h1[id] === h && this.h2[id] === g && this.lens[id] === len) return id;
    }
  }

  private add(term: string, h: number, g: number, len: number): number {
    const id = this.strings.length;
    if (id >= this.h1.length) {
      const n = this.h1.length * 2;
      this.h1 = grow(this.h1, n);
      this.h2 = grow(this.h2, n);
      this.lens = grow(this.lens, n);
    }
    this.strings.push(term);
    this.h1[id] = h;
    this.h2[id] = g;
    this.lens[id] = len;
    if ((id + 1) * 2 > this.slots.length) this.rehash(this.slots.length * 2);
    else this.place(id, h);
    return id;
  }

  private place(id: number, h: number): void {
    const mask = this.mask;
    let i = h & mask;
    while (this.slots[i] !== 0) i = (i + 1) & mask;
    this.slots[i] = id + 1;
  }

  private rehash(size: number): void {
    this.slots = new Int32Array(size);
    this.mask = size - 1;
    for (let id = 0; id < this.strings.length; id++) this.place(id, this.h1[id]!);
  }
}

/** Length of a folded term as the tokenizer counts it: characters that fold to nothing do not count. */
function foldedLength(folded: string): number {
  let n = 0;
  for (let i = 0; i < folded.length; i++) {
    const c = folded.charCodeAt(i);
    if ((c < 128 ? FOLD[c]! : foldOf(c)) !== FOLD_DROP) n++;
  }
  return n;
}

function grow(a: Uint32Array, n: number): Uint32Array {
  const b = new Uint32Array(n);
  b.set(a);
  return b;
}
