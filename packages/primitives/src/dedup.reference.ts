/**
 * `TextSketcher` as it was before D998, unchanged but for its name: per vocabulary id it kept the term's hash, its
 * digit flag and its unsegmented-script units in arrays the size of the vocabulary (about 13 bytes an id: 0.4 MB of a
 * heavy user's 32,768-id vocabulary). Kept as the oracle `dedup.test.ts` compares `TextSketcher` with, output for
 * output; not exported.
 */
import { fnv1a, mix32 } from "./hash";
import { tokenizeInto } from "./tokenize";
import type { Vocab } from "./vocab";
import { isUnsegmented, MAX_PERMUTATIONS } from "./dedup";

// Per-permutation seeds, from a fixed splitmix32 stream: signatures must agree across processes and versions.
const PERM_SEEDS = new Uint32Array(MAX_PERMUTATIONS);
{
  let x = 0x2545f491;
  for (let i = 0; i < MAX_PERMUTATIONS; i++) {
    x = (x + 0x9e3779b9) | 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    PERM_SEEDS[i] = (z ^ (z >>> 16)) >>> 0;
  }
}

// Scratch shared by every sketcher: the term ids, unit sequence and shingle hashes of the text loaded last. Each
// per-user cache held its own copy before (3 x maxTerms words: 96 KB at 8,192 terms, most of a user's fixed memory
// in the simulation's memory scenario). JavaScript runs one load at a time, so one copy serves all.
let scratchIds = new Uint32Array(0);
let scratchSeq = new Uint32Array(0);
let scratchShingles = new Uint32Array(0);
let owner: ReferenceSketcher | null = null;

/** Starting length of a sketcher's per-id arrays and unit pool; a power of two, so doubling stays aligned. */
const INITIAL_SLOTS = 64;

/**
 * Tokenizes a text once and derives its fingerprint, MinHash signature and SimHash from the same terms. Share the
 * Vocab with the index that tokenizes the same texts.
 *
 * Usage: `load(text)`, then any of `fingerprint`, `minhash`, `simhash`, before any other sketcher loads: loaded
 * terms live in scratch shared by all sketchers, and reading them after another sketcher's `load` throws.
 */
export class ReferenceSketcher {
  readonly vocab: Vocab;
  /** Terms per text beyond this are ignored (about 6 characters per term). */
  readonly maxTerms: number;
  /** Words per shingle. */
  readonly shingleSize: number;
  // Per vocabulary id: the term's hash, or, for a term in a script written without spaces, a run of unit hashes in
  // `pool` (expLen > 0). Filled on an id's first use, and again after the vocabulary releases the id (it may then
  // name another term): `state` is 0 until filled, else HASHED, plus NUMERIC when the term holds a digit.
  // All five start at INITIAL_SLOTS and double as ids and units need (`growTerms`, `poolPush`): the engine keeps one
  // sketcher per user and most users hold few terms, so 1,024-slot arrays were ~17 KB of a one-item user's ~29.5 KB.
  private termHashes: Uint32Array = new Uint32Array(INITIAL_SLOTS);
  private expStart: Uint32Array = new Uint32Array(INITIAL_SLOTS);
  private expLen: Uint32Array = new Uint32Array(INITIAL_SLOTS);
  private state: Uint8Array = new Uint8Array(INITIAL_SLOTS);
  private pool: Uint32Array = new Uint32Array(INITIAL_SLOTS);
  private poolUsed = 0;
  // Pool units that a live id's run holds; the rest belong to released ids, reclaimed by `compactPool`.
  private poolLive = 0;
  private terms = 0;
  private shingleCount = 0;
  private numbers = 0;

  constructor(vocab: Vocab, maxTerms: number, shingleSize: number) {
    if (shingleSize < 1 || shingleSize > 8) throw new RangeError("shingleSize must be 1..8");
    this.vocab = vocab;
    this.maxTerms = maxTerms;
    this.shingleSize = shingleSize;
    vocab.onRelease((id) => this.forgetTerm(id));
  }

  /** Drops what was derived from a released id's term: the id may come back as another term. */
  private forgetTerm(id: number): void {
    if (id >= this.state.length || this.state[id] === 0) return;
    this.state[id] = 0;
    this.poolLive -= this.expLen[id]!;
    this.expLen[id] = 0;
  }

  /** The shared scratch, checked to still hold this sketcher's text. */
  private loaded(): void {
    if (owner !== this) throw new Error("ReferenceSketcher: another sketcher loaded since this one did; load() again");
  }

  /**
   * Units in the loaded text: its terms, except that a term in a script written without spaces (Chinese, Japanese,
   * Thai: the tokenizer keeps a whole run as one term) counts as its character bigrams, so an edit inside a
   * sentence changes a few units, not the whole sentence.
   */
  get termCount(): number {
    return this.terms;
  }

  /** Shingles in the loaded text (with repeats): a text with fewer units than `shingleSize` has one. */
  get shingles(): number {
    return this.shingleCount;
  }

  /** Copies the loaded text's shingle hashes (with repeats, in text order) into `out`; returns how many. */
  copyShingles(out: Uint32Array): number {
    this.loaded();
    const n = Math.min(this.shingleCount, out.length);
    out.set(scratchShingles.subarray(0, n));
    return n;
  }

  /**
   * An order-independent 32-bit key of the loaded text's terms that contain a digit (amounts, dates, times, ids,
   * counts): two texts with different keys differ in at least one number. Near-duplicates by wording that differ in
   * a number are usually different facts ("moved to 3pm" / "moved to 4pm", order #1043 / #1044), so a caller that
   * merges near-duplicates can require equal keys. 0 when the text has no numbers.
   */
  get numberKey(): number {
    return this.numbers;
  }

  /** Tokenizes `text` (interning new terms) and computes its shingles. Returns the unit count (`termCount`). */
  load(text: string): number {
    const cap = this.maxTerms;
    if (scratchIds.length < cap) {
      scratchIds = new Uint32Array(cap);
      scratchSeq = new Uint32Array(cap);
      scratchShingles = new Uint32Array(cap);
    }
    owner = this;
    const ids = scratchIds.length === cap ? scratchIds : scratchIds.subarray(0, cap);
    const found = tokenizeInto(text, this.vocab, true, ids, null);
    if (this.vocab.size > this.state.length) this.growTerms(this.vocab.size);
    const th = this.termHashes;
    const expLen = this.expLen;
    const seq = scratchSeq;
    const state = this.state;
    let n = 0;
    let numbers = 0;
    for (let i = 0; i < found && n < cap; i++) {
      const id = ids[i]!;
      let st = state[id]!;
      if (st === 0) st = this.hashTerm(id);
      // A sum of mixed hashes: a multiset key, so the order numbers appear in does not matter.
      if (st === HASHED_NUMERIC) numbers = (numbers + mix32(th[id]! ^ 0x7f4a7c15)) | 0;
      const len = expLen[id]!;
      if (len === 0) {
        seq[n++] = th[id]!;
        continue;
      }
      const start = this.expStart[id]!;
      const pool = this.pool; // read after hashTerm, which may have grown or compacted it
      for (let j = 0; j < len && n < cap; j++) seq[n++] = pool[start + j]!;
    }
    this.terms = n;
    this.numbers = numbers >>> 0;

    const w = this.shingleSize;
    const sh = scratchShingles;
    if (n === 0) {
      this.shingleCount = 0;
    } else if (n < w) {
      sh[0] = shingleHash(seq, 0, n);
      this.shingleCount = 1;
    } else {
      const count = n - w + 1;
      for (let i = 0; i < count; i++) sh[i] = shingleHash(seq, i, w);
      this.shingleCount = count;
    }
    return n;
  }

  /**
   * 64-bit fingerprint of the term sequence, as two 32-bit lanes in `out[0]`, `out[1]`: equal for texts with the
   * same terms in the same order. Lanes are independent hashes, so a collision needs both to collide.
   */
  fingerprint(out: Uint32Array): void {
    this.loaded();
    const seq = scratchSeq;
    const n = this.terms;
    let a = 0x811c9dc5 ^ n;
    let b = 0x2545f491 ^ n;
    for (let i = 0; i < n; i++) {
      const t = seq[i]!;
      a = Math.imul(a ^ t, 0x01000193);
      a = (a << 13) | (a >>> 19);
      b = Math.imul(b ^ ((t << 16) | (t >>> 16)), 0x5bd1e995);
      b ^= b >>> 15;
    }
    out[0] = mix32(a);
    out[1] = mix32(b ^ a);
  }

  /**
   * MinHash signature with `sig.length` permutations (≤ MAX_PERMUTATIONS) over the shingle set. The fraction of
   * equal positions between two signatures estimates their Jaccard similarity (`minhashSimilarity`). An empty text
   * gets all 0xffffffff.
   */
  minhash(sig: Uint32Array): void {
    const k = sig.length;
    if (k > MAX_PERMUTATIONS) throw new RangeError(`at most ${MAX_PERMUTATIONS} permutations`);
    this.loaded();
    const sh = scratchShingles;
    const n = this.shingleCount;
    for (let i = 0; i < k; i++) {
      const seed = PERM_SEEDS[i]!;
      let min = 0xffffffff;
      for (let j = 0; j < n; j++) {
        // A seeded xor-multiply-xorshift: one multiply per value, 1.5–2.7x cheaper than a full murmur finalizer
        // across runs (bench/dedup.bench.ts, perm), with the same bias and error (dedup.test.ts). Sound only because
        // its input is already mixed (shingleHash ends in mix32): on raw structured values it is biased (+0.05).
        let v = Math.imul(sh[j]! ^ seed, 0x85ebca6b);
        v = (v ^ (v >>> 13)) >>> 0;
        if (v < min) min = v;
      }
      sig[i] = min;
    }
  }

  /**
   * 64-bit SimHash over the shingles (each counted as often as it occurs), as two lanes in `out[0]`, `out[1]`.
   * Similar texts differ in few bits (`hamming64`). An empty text gets 0.
   */
  simhash(out: Uint32Array): void {
    this.loaded();
    const sh = scratchShingles;
    const n = this.shingleCount;
    const counts = simCounts;
    counts.fill(0);
    for (let j = 0; j < n; j++) {
      const lo = sh[j]!;
      const hi = mix32(lo ^ 0x9e3779b9);
      for (let b = 0; b < 32; b++) {
        counts[b]! += ((lo >>> b) & 1) * 2 - 1;
        counts[b + 32]! += ((hi >>> b) & 1) * 2 - 1;
      }
    }
    let lo = 0;
    let hi = 0;
    for (let b = 0; b < 32; b++) {
      if (counts[b]! > 0) lo |= 1 << b;
      if (counts[b + 32]! > 0) hi |= 1 << b;
    }
    out[0] = lo >>> 0;
    out[1] = hi >>> 0;
  }

  /** Grows the per-id arrays so ids below `size` fit. */
  private growTerms(size: number): void {
    let n = this.termHashes.length;
    while (n < size) n *= 2;
    this.termHashes = grown(this.termHashes, n);
    this.expStart = grown(this.expStart, n);
    this.expLen = grown(this.expLen, n);
    const state = new Uint8Array(n);
    state.set(this.state);
    this.state = state;
  }

  /** Fills an id's hash (and units, for unsegmented script) from its term; returns its new `state`. */
  private hashTerm(id: number): number {
    const term = this.vocab.term(id);
    this.termHashes[id] = mix32(fnv1a(term, 0, term.length));
    if (hasUnsegmented(term)) this.expand(id, term);
    const st = /[0-9]/.test(term) ? HASHED_NUMERIC : HASHED;
    this.state[id] = st;
    return st;
  }

  /**
   * Units of a term containing unsegmented script: each maximal run of such characters as its character bigrams (a
   * single character alone), each other run as one unit. "osakaの小さなホテル" → osaka, の小, 小さ, さな, なホ, ホテ, テル.
   */
  private expand(id: number, term: string): void {
    // Released ids' runs are dead weight: once they are most of the pool, copy the live runs down.
    if (this.poolUsed > 1_024 && this.poolUsed > 2 * this.poolLive + term.length * 2) this.compactPool();
    const start = this.poolUsed;
    let i = 0;
    while (i < term.length) {
      let j = i;
      if (isUnsegmented(term.charCodeAt(i))) {
        while (j < term.length && isUnsegmented(term.charCodeAt(j))) j++;
        if (j - i === 1) this.poolPush(mix32(fnv1a(term, i, j)));
        for (let k = i; k + 1 < j; k++) this.poolPush(mix32(fnv1a(term, k, k + 2)));
      } else {
        while (j < term.length && !isUnsegmented(term.charCodeAt(j))) j++;
        this.poolPush(mix32(fnv1a(term, i, j)));
      }
      i = j;
    }
    this.expStart[id] = start;
    this.expLen[id] = this.poolUsed - start;
    this.poolLive += this.poolUsed - start;
  }

  /** Copies the live ids' unit runs to the front of a fresh pool, dropping released ids' runs. */
  private compactPool(): void {
    // The floor is the starting size, not 1,024: a larger floor would bring the big pool back after one compaction.
    const pool = new Uint32Array(Math.max(INITIAL_SLOTS, this.poolLive * 2));
    let used = 0;
    for (let id = 0; id < this.state.length; id++) {
      const len = this.expLen[id]!;
      if (len === 0) continue;
      pool.set(this.pool.subarray(this.expStart[id]!, this.expStart[id]! + len), used);
      this.expStart[id] = used;
      used += len;
    }
    this.pool = pool;
    this.poolUsed = used;
  }

  private poolPush(h: number): void {
    if (this.poolUsed === this.pool.length) this.pool = grown(this.pool, this.pool.length * 2);
    this.pool[this.poolUsed++] = h;
  }
}

const HASHED = 1;
const HASHED_NUMERIC = 3;

function grown(a: Uint32Array, n: number): Uint32Array {
  const b = new Uint32Array(n);
  b.set(a);
  return b;
}

function hasUnsegmented(term: string): boolean {
  for (let i = 0; i < term.length; i++) if (isUnsegmented(term.charCodeAt(i))) return true;
  return false;
}

const simCounts = new Int32Array(64);

function shingleHash(seq: Uint32Array, start: number, w: number): number {
  let x = 0x9747b28c ^ w;
  for (let t = 0; t < w; t++) {
    x = Math.imul(x ^ seq[start + t]!, 0x5bd1e995);
    x ^= x >>> 15;
  }
  return mix32(x);
}
