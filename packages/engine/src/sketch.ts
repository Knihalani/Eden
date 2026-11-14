/**
 * A source's vocabulary sketch (`routeSketch`, D322): a Bloom filter of the terms in what the sync read from the
 * source, kept after the user's cap trims the items themselves. Routing reads it for a request that names no one: with
 * 1,000 connectors, the few a mailbox keeps under the cap say little of what it holds (A1), but the terms of every
 * page the backfill read still do.
 *
 * Bounded: `MAX_BITS` (4 KB) while it fills; once the source is warm it is folded (its two halves OR-ed, which a
 * power-of-two filter allows) while the fill stays low, so a quiet connector of a few hundred terms keeps 128-512 B.
 * Content-free in the sense D8 asks of the source map: it holds hashed bits, never a word, and lives in memory only,
 * per (user, source) like the rest of the sync's state (D9), except with the operator's opt-in to persisting frozen
 * users (D425), where it is saved encrypted with them.
 */
import { hashString } from "@eden/primitives";
import { isStopword, readWordUnit, stopwordAt, WORD_UNITS } from "./text";

/** The sketch's size while it fills (bits, a power of two). */
const MAX_BITS = 1 << 15;
/** The smallest it folds to. */
const MIN_BITS = 1 << 10;
/** Folding stops before the fill passes this: past it a k = 2 filter's false matches pass ~4%. */
const FOLD_FILL = 0.2;
/** A fill past this restarts the sketch: a k = 2 filter half full matches a quarter of the terms it never saw. */
const SATURATED = 0.5;

export class TermSketch {
  private bits = new Uint32Array(MAX_BITS / 32);
  private set = 0;

  /** Bytes held. */
  get bytes(): number {
    return this.bits.byteLength;
  }

  /** Adds a term by its two hashes (`termHashes`). */
  add(h1: number, h2: number): void {
    // Saturated (a folded sketch whose source grew, or a busy one): it would match every term, so it starts again,
    // full size, from what comes next (the daily sweep re-lists the source). The review measured 96% false matches.
    if (this.set > SATURATED * this.bits.length * 32) {
      this.bits = new Uint32Array(MAX_BITS / 32);
      this.set = 0;
    }
    const mask = this.bits.length * 32 - 1;
    this.setBit(h1 & mask);
    this.setBit((h1 + h2) & mask);
  }

  /** Whether the term may be in the sketch (never false for one added). */
  has(h1: number, h2: number): boolean {
    const mask = this.bits.length * 32 - 1;
    return this.bit(h1 & mask) && this.bit((h1 + h2) & mask);
  }

  /** Halves the sketch while the fill after halving stays under `FOLD_FILL`. Terms added keep matching. */
  fold(): void {
    for (;;) {
      const n = this.bits.length;
      if (n * 32 <= MIN_BITS) return;
      const f = this.set / (n * 32);
      if (1 - (1 - f) * (1 - f) > FOLD_FILL) return;
      const half = new Uint32Array(n / 2);
      let set = 0;
      for (let i = 0; i < n / 2; i++) {
        half[i] = this.bits[i]! | this.bits[i + n / 2]!;
        set += popcount(half[i]!);
      }
      this.bits = half;
      this.set = set;
    }
  }

  /** The sketch as JSON can hold it (D425: saved, encrypted, with a persisted user's sync state). */
  dump(): { bits: string; set: number } {
    return {
      bits: Buffer.from(this.bits.buffer, this.bits.byteOffset, this.bits.byteLength).toString("base64"),
      set: this.set,
    };
  }

  /** A sketch from `dump`'s output, or null when it is not one (a power-of-two size within the bounds). */
  static load(d: unknown): TermSketch | null {
    const x = d as { bits?: unknown; set?: unknown } | null;
    if (typeof x?.bits !== "string" || typeof x.set !== "number") return null;
    const bytes = Buffer.from(x.bits, "base64");
    const words = bytes.byteLength / 4;
    if (!Number.isInteger(words) || words * 32 < MIN_BITS || words * 32 > MAX_BITS || (words & (words - 1)) !== 0) {
      return null;
    }
    const t = new TermSketch();
    t.bits = new Uint32Array(words);
    new Uint8Array(t.bits.buffer).set(bytes);
    let set = 0;
    for (const w of t.bits) set += popcount(w);
    t.set = set;
    return t;
  }

  private setBit(i: number): void {
    const w = i >>> 5;
    const b = 1 << (i & 31);
    if ((this.bits[w]! & b) === 0) {
      this.bits[w] = this.bits[w]! | b;
      this.set++;
    }
  }

  private bit(i: number): boolean {
    return (this.bits[i >>> 5]! & (1 << (i & 31))) !== 0;
  }
}

/** A term's two hashes for the sketch (a term as `sketchTerms` gives it). */
export function termHashes(term: string): [number, number] {
  const h1 = termHash(term);
  return [h1, secondHash(h1)];
}

/** `termHashes`' first hash, with no pair made (the sync's store hashes every listed item's terms, D1886). */
export function termHash(term: string): number {
  return hashString(term, SEED) >>> 0;
}

/** `termHashes`' second hash, from the first. It is odd, so h1 + h2 walks every bit of a power-of-two filter. */
export function secondHash(h1: number): number {
  return (Math.imul(h1 ^ (h1 >>> 15), 0x2c1b3c6d) >>> 0) | 1;
}

const SEED = 0x5ee7;
const SPLIT = /[^\p{L}\p{N}]+/u;
const DIGIT = /\d/;

/**
 * The terms the sketch keeps of a text, and a request is matched on: lowercase words of three or more letters with no
 * digit (ticket numbers and ids would fill a sketch with terms no request names), stopwords out, each once.
 */
export function sketchTerms(text: string): string[] {
  // One pass over the lower-cased text's code units (D1886): the split made a string of every word, two-letter ones
  // and ones with a figure too, and tested each by a regex and a set; this tests a word where it lies (its hash for
  // repeats, `stopwordAt` for stopwords) and makes a string only of a new one it keeps (D1887). A text with a
  // surrogate is read by the split, whose `u` flag reads a pair as one code point.
  const lower = text.toLowerCase();
  const out: string[] = [];
  // At most one word every two code units: the table stays under half full.
  const size = tableFor(lower.length);
  const mask = size - 1;
  if (++stamp === 0xffffffff) {
    stamps.fill(0);
    stamp = 1;
  }
  let start = -1;
  let figure = false;
  let h = 0;
  for (let i = 0; i <= lower.length; i++) {
    const c = i < lower.length ? lower.charCodeAt(i) : 32;
    let k = WORD_UNITS[c]!;
    if (k === 0 && (k = readWordUnit(c)) === 0) return sketchTermsSplit(text);
    if (k === 1) {
      if (start < 0) {
        start = i;
        figure = false;
        h = 0x811c9dc5;
      }
      // `DIGIT` (no `u` flag): the ASCII figures only.
      if (c >= 48 && c <= 57) figure = true;
      h = Math.imul(h ^ c, 0x01000193);
    } else if (start >= 0) {
      const len = i - start;
      if (len >= 3 && !figure && !stopwordAt(lower, start, i)) {
        // A word seen before in this text: same hash, same length, same units.
        let slot = h & mask;
        for (;;) {
          if (stamps[slot] !== stamp) {
            const w = lower.slice(start, i);
            stamps[slot] = stamp;
            hashes[slot] = h;
            words[slot] = out.length;
            out.push(w);
            break;
          }
          if (hashes[slot] === h) {
            const seen = out[words[slot]!]!;
            if (seen.length === len && lower.startsWith(seen, start)) break;
          }
          slot = (slot + 1) & mask;
        }
      }
      start = -1;
    }
  }
  return out;
}

/**
 * `sketchTerms`' table of the words a text has given (D1887): per slot the stamp of the call that filled it, the
 * word's hash and its place in the output. Process-wide scratch of integers only, sized to the longest text read (a
 * slot per code unit): no word outlives its call, and a new stamp empties it.
 */
let stamps = new Uint32Array(1_024);
let hashes = new Int32Array(1_024);
let words = new Int32Array(1_024);
let stamp = 0;

/** The table's size for a text (a power of two at least the text's length), grown when needed. */
function tableFor(chars: number): number {
  let size = stamps.length;
  while (size < chars) size *= 2;
  if (size > stamps.length) {
    stamps = new Uint32Array(size);
    hashes = new Int32Array(size);
    words = new Int32Array(size);
    stamp = 0;
  }
  // A short text uses a small table's prefix: its probes stay in the cache's lines.
  let used = 64;
  while (used < chars * 2 && used < size) used *= 2;
  return used;
}

/** `sketchTerms` by its split, as it read every text before D1886: the reading of a text with a surrogate. */
export function sketchTermsSplit(text: string): string[] {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(SPLIT)) {
    if (w.length < 3 || DIGIT.test(w) || isStopword(w)) continue;
    out.add(w);
  }
  return [...out];
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
}
