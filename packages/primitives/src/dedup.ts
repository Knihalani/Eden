/**
 * Duplicate and near-duplicate detection over text: an exact fingerprint, MinHash with an LSH index, and SimHash.
 *
 * All three see a text as its term sequence from the shared tokenizer (`tokenizeInto`), so case, accents, punctuation
 * and whitespace never matter, and a term hash is computed once per vocabulary id, not once per occurrence. Hashes
 * come from the folded term string (FNV-1a, then murmur's finalizer), not from the id, so fingerprints and signatures
 * are stable across processes and vocabularies and can be stored. All 32-bit `Math.imul` arithmetic: no BigInt.
 *
 * Which to use (measured in docs/research/primitives-dedup.md on a synthetic mailbox of quoted threads, forwards,
 * synced copies and edited documents; word 3-shingles, text reduced by `dedupText` first):
 * - `fingerprint`: synced copies and bare forwards (same words; whitespace, case, accents encoding, punctuation and
 *   line endings ignored). Precision 1.000 on the test corpus; misses edits.
 * - `simhash` (8 bytes an item) compared by a linear scan at Hamming distance ≤ 8: the default for per-user stores
 *   up to ~10k items and for deduping a page of results. F1 0.963.
 * - `minhash` (k=128, 512 bytes an item) at estimated Jaccard ≥ 0.8, with `MinHashIndex` for sublinear lookup:
 *   when edited documents matter most (F1 0.980, the best measured) or a store is too big to scan (100k items:
 *   ~1.5 µs per LSH lookup against 0.46–0.60 ms per SimHash scan across runs).
 * Without stripping quotes first, every reply looks like its parent (MinHash precision 0.58 instead of 0.98).
 */
import { fnv1a, mix32 } from "./hash";
import { tokenizeInto } from "./tokenize";
import type { Vocab } from "./vocab";

/** The most permutations a MinHash signature may have. */
export const MAX_PERMUTATIONS = 512;

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
let owner: TextSketcher | null = null;

/**
 * Tokenizes a text once and derives its fingerprint, MinHash signature and SimHash from the same terms. Share the
 * Vocab with the index that tokenizes the same texts.
 *
 * Usage: `load(text)`, then any of `fingerprint`, `minhash`, `simhash`, before any other sketcher loads: loaded
 * terms live in scratch shared by all sketchers, and reading them after another sketcher's `load` throws.
 */
export class TextSketcher {
  readonly vocab: Vocab;
  /** Terms per text beyond this are ignored (about 6 characters per term). */
  readonly maxTerms: number;
  /** Words per shingle. */
  readonly shingleSize: number;
  // Per vocabulary id: the term's hash, or, for a term in a script written without spaces, a run of unit hashes in
  // `pool` (expLen > 0). Filled once per id.
  private termHashes: Uint32Array = new Uint32Array(1_024);
  private expStart: Uint32Array = new Uint32Array(1_024);
  private expLen: Uint32Array = new Uint32Array(1_024);
  private numeric: Uint8Array = new Uint8Array(1_024);
  private pool: Uint32Array = new Uint32Array(1_024);
  private poolUsed = 0;
  private hashed = 0;
  private terms = 0;
  private shingleCount = 0;
  private numbers = 0;

  constructor(vocab: Vocab, maxTerms: number, shingleSize: number) {
    if (shingleSize < 1 || shingleSize > 8) throw new RangeError("shingleSize must be 1..8");
    this.vocab = vocab;
    this.maxTerms = maxTerms;
    this.shingleSize = shingleSize;
  }

  /** The shared scratch, checked to still hold this sketcher's text. */
  private loaded(): void {
    if (owner !== this) throw new Error("TextSketcher: another sketcher loaded since this one did; load() again");
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
    this.hashNewTerms();
    const th = this.termHashes;
    const expLen = this.expLen;
    const seq = scratchSeq;
    const numeric = this.numeric;
    let n = 0;
    let numbers = 0;
    for (let i = 0; i < found && n < cap; i++) {
      const id = ids[i]!;
      // A sum of mixed hashes: a multiset key, so the order numbers appear in does not matter.
      if (numeric[id] === 1) numbers = (numbers + mix32(th[id]! ^ 0x7f4a7c15)) | 0;
      const len = expLen[id]!;
      if (len === 0) {
        seq[n++] = th[id]!;
        continue;
      }
      const start = this.expStart[id]!;
      for (let j = 0; j < len && n < cap; j++) seq[n++] = this.pool[start + j]!;
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

  private hashNewTerms(): void {
    const size = this.vocab.size;
    if (size <= this.hashed) return;
    if (size > this.termHashes.length) {
      let n = this.termHashes.length;
      while (n < size) n *= 2;
      this.termHashes = grown(this.termHashes, n);
      this.expStart = grown(this.expStart, n);
      this.expLen = grown(this.expLen, n);
      const numeric = new Uint8Array(n);
      numeric.set(this.numeric);
      this.numeric = numeric;
    }
    for (let id = this.hashed; id < size; id++) {
      const term = this.vocab.term(id);
      this.termHashes[id] = mix32(fnv1a(term, 0, term.length));
      if (hasUnsegmented(term)) this.expand(id, term);
      if (/[0-9]/.test(term)) this.numeric[id] = 1;
    }
    this.hashed = size;
  }

  /**
   * Units of a term containing unsegmented script: each maximal run of such characters as its character bigrams (a
   * single character alone), each other run as one unit. "osakaの小さなホテル" → osaka, の小, 小さ, さな, なホ, ホテ, テル.
   */
  private expand(id: number, term: string): void {
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
  }

  private poolPush(h: number): void {
    if (this.poolUsed === this.pool.length) this.pool = grown(this.pool, this.pool.length * 2);
    this.pool[this.poolUsed++] = h;
  }
}

function grown(a: Uint32Array, n: number): Uint32Array {
  const b = new Uint32Array(n);
  b.set(a);
  return b;
}

/**
 * Whether code unit `c` belongs to a script written without spaces between words: Thai, Lao, Myanmar, Khmer, kana,
 * CJK ideographs. Hangul is not: Korean separates words with spaces.
 */
export function isUnsegmented(c: number): boolean {
  if (c < 0x0e00) return false;
  if (c <= 0x0eff) return true; // Thai, Lao
  if (c >= 0x1000 && c <= 0x109f) return true; // Myanmar
  if (c >= 0x1780 && c <= 0x17ff) return true; // Khmer
  if (c >= 0x3040 && c <= 0x30ff) return true; // Hiragana, Katakana
  if (c >= 0x3400 && c <= 0x4dbf) return true; // CJK extension A
  if (c >= 0x4e00 && c <= 0x9fff) return true; // CJK unified ideographs
  if (c >= 0xf900 && c <= 0xfaff) return true; // CJK compatibility ideographs
  return c >= 0xff66 && c <= 0xff9f; // half-width Katakana
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

/** Estimated Jaccard similarity: the fraction of equal positions in two signatures of the same length. */
export function minhashSimilarity(a: Uint32Array, b: Uint32Array): number {
  const k = a.length;
  if (b.length !== k) throw new RangeError("signatures differ in length");
  let eq = 0;
  for (let i = 0; i < k; i++) if (a[i] === b[i]) eq++;
  return eq / k;
}

/** Bits that differ between two 64-bit values given as (lo, hi) lanes. */
export function hamming64(aLo: number, aHi: number, bLo: number, bHi: number): number {
  return popcount32((aLo ^ bLo) >>> 0) + popcount32((aHi ^ bHi) >>> 0);
}

export function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

/**
 * Probability that a pair with Jaccard similarity `s` shares at least one band of `rows` values among `bands`:
 * 1 − (1 − s^rows)^bands. For choosing bands and rows.
 */
export function lshCandidateProbability(s: number, bands: number, rows: number): number {
  return 1 - Math.pow(1 - Math.pow(s, rows), bands);
}

/**
 * LSH index over MinHash signatures: `bands` bands of `rows` values each; two signatures are candidates when they
 * agree on all values of at least one band. Verify candidates with `minhashSimilarity` (the index does not store
 * signatures; the caller has them).
 *
 * Ids are the caller's dense slot numbers (0 ≤ id < 2^31), e.g. an item cache's slot. Storage is one open-addressed
 * table of (band key, id) pairs with linear probing and backward-shift deletion: no per-entry objects, and removal
 * leaves no tombstones, so an index under constant churn (a TTL cache) stays as fast as a fresh one.
 */
export class MinHashIndex {
  readonly bands: number;
  readonly rows: number;
  private keys: Uint32Array;
  private vals: Int32Array; // id + 1; 0 = empty
  private mask: number;
  private used = 0;
  private stamps = new Uint32Array(1_024);
  private epoch = 0;
  private readonly bandKeys: Uint32Array;

  constructor(bands: number, rows: number, capacity: number) {
    if (bands < 1 || rows < 1) throw new RangeError("bands and rows must be positive");
    this.bands = bands;
    this.rows = rows;
    const size = 1 << Math.ceil(Math.log2(Math.max(64, capacity * bands * 2)));
    this.keys = new Uint32Array(size);
    this.vals = new Int32Array(size);
    this.mask = size - 1;
    this.bandKeys = new Uint32Array(bands);
  }

  /** Entries (one per band per indexed id). */
  get size(): number {
    return this.used;
  }

  /** Indexes `id` under its signature's band keys. Adding the same id twice with one signature is a no-op. */
  add(id: number, sig: Uint32Array): void {
    this.computeKeys(sig);
    if ((this.used + this.bands) * 2 > this.keys.length) this.resize(this.keys.length * 2);
    const keys = this.keys;
    const vals = this.vals;
    const mask = this.mask;
    const v = id + 1;
    for (let b = 0; b < this.bands; b++) {
      const key = this.bandKeys[b]!;
      let i = mix32(key) & mask;
      let present = false;
      while (vals[i] !== 0) {
        if (keys[i] === key && vals[i] === v) {
          present = true;
          break;
        }
        i = (i + 1) & mask;
      }
      if (present) continue;
      keys[i] = key;
      vals[i] = v;
      this.used++;
    }
  }

  /** Removes `id`, which must have been added with this signature. */
  remove(id: number, sig: Uint32Array): void {
    this.computeKeys(sig);
    const v = id + 1;
    for (let b = 0; b < this.bands; b++) {
      const key = this.bandKeys[b]!;
      let i = mix32(key) & this.mask;
      while (this.vals[i] !== 0) {
        if (this.keys[i] === key && this.vals[i] === v) {
          this.deleteAt(i);
          break;
        }
        i = (i + 1) & this.mask;
      }
    }
  }

  /**
   * Writes the distinct ids sharing at least one band with `sig` into `out` (up to its length) and returns how many.
   */
  candidates(sig: Uint32Array, out: Int32Array): number {
    this.computeKeys(sig);
    if (++this.epoch === 0xffffffff) {
      this.stamps.fill(0);
      this.epoch = 1;
    }
    const keys = this.keys;
    const vals = this.vals;
    const mask = this.mask;
    const epoch = this.epoch;
    let n = 0;
    for (let b = 0; b < this.bands; b++) {
      const key = this.bandKeys[b]!;
      for (let i = mix32(key) & mask; vals[i] !== 0; i = (i + 1) & mask) {
        if (keys[i] !== key) continue;
        const id = vals[i]! - 1;
        if (id >= this.stamps.length) this.growStamps(id + 1);
        if (this.stamps[id] === epoch) continue;
        this.stamps[id] = epoch;
        if (n < out.length) out[n] = id;
        n++;
      }
    }
    return Math.min(n, out.length);
  }

  private computeKeys(sig: Uint32Array): void {
    const r = this.rows;
    if (sig.length < this.bands * r) throw new RangeError("signature shorter than bands × rows");
    for (let b = 0; b < this.bands; b++) {
      // The band number is hashed in, so equal values in different bands are different keys.
      let x = Math.imul(b + 1, 0x9e3779b1);
      const base = b * r;
      for (let j = 0; j < r; j++) {
        x = Math.imul(x ^ sig[base + j]!, 0x5bd1e995);
        x ^= x >>> 15;
      }
      this.bandKeys[b] = mix32(x);
    }
  }

  private deleteAt(i: number): void {
    // Backward-shift deletion: pull later entries of the probe run back so no lookup stops early at a hole.
    const keys = this.keys;
    const vals = this.vals;
    const mask = this.mask;
    let hole = i;
    let j = i;
    for (;;) {
      j = (j + 1) & mask;
      if (vals[j] === 0) break;
      const home = mix32(keys[j]!) & mask;
      // Move j into the hole if its home slot is not in the cyclic range (hole, j].
      const inRange = hole <= j ? home > hole && home <= j : home > hole || home <= j;
      if (inRange) continue;
      keys[hole] = keys[j]!;
      vals[hole] = vals[j]!;
      hole = j;
    }
    vals[hole] = 0;
    keys[hole] = 0;
    this.used--;
  }

  private resize(size: number): void {
    const oldKeys = this.keys;
    const oldVals = this.vals;
    this.keys = new Uint32Array(size);
    this.vals = new Int32Array(size);
    this.mask = size - 1;
    for (let i = 0; i < oldVals.length; i++) {
      if (oldVals[i] === 0) continue;
      let j = mix32(oldKeys[i]!) & this.mask;
      while (this.vals[j] !== 0) j = (j + 1) & this.mask;
      this.keys[j] = oldKeys[i]!;
      this.vals[j] = oldVals[i]!;
    }
  }

  private growStamps(n: number): void {
    let size = this.stamps.length;
    while (size < n) size *= 2;
    const next = new Uint32Array(size);
    next.set(this.stamps);
    this.stamps = next;
  }
}
