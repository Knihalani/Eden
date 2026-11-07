/**
 * A source's vocabulary sketch (`routeSketch`, D322): a Bloom filter of the terms in what the sync read from the
 * source, kept after the user's cap trims the items themselves. Routing reads it for a request that names no one: with
 * 1,000 connectors, the few a mailbox keeps under the cap say little of what it holds (A1), but the terms of every
 * page the backfill read still do.
 *
 * Bounded: `MAX_BITS` (4 KB) while it fills; once the source is warm it is folded (its two halves OR-ed, which a
 * power-of-two filter allows) while the fill stays low, so a quiet connector of a few hundred terms keeps 128-512 B.
 * Content-free in the sense D8 asks of the source map: it holds hashed bits, never a word, and lives in memory only,
 * per (user, source) like the rest of the sync's state (D9).
 */
import { hashString } from "@eden/primitives";
import { isStopword } from "./text";

/** The sketch's size while it fills (bits, a power of two). */
const MAX_BITS = 1 << 15;
/** The smallest it folds to. */
const MIN_BITS = 1 << 10;
/** Folding stops before the fill passes this: past it a k = 2 filter's false matches pass ~4%. */
const FOLD_FILL = 0.2;

export class TermSketch {
  private bits = new Uint32Array(MAX_BITS / 32);
  private set = 0;

  /** Bytes held. */
  get bytes(): number {
    return this.bits.byteLength;
  }

  /** Adds a term by its two hashes (`termHashes`). */
  add(h1: number, h2: number): void {
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
  const h1 = hashString(term, SEED) >>> 0;
  // The second hash is odd, so h1 + h2 walks every bit of a power-of-two filter.
  const h2 = (Math.imul(h1 ^ (h1 >>> 15), 0x2c1b3c6d) >>> 0) | 1;
  return [h1, h2];
}

const SEED = 0x5ee7;
const SPLIT = /[^\p{L}\p{N}]+/u;
const DIGIT = /\d/;

/**
 * The terms the sketch keeps of a text, and a request is matched on: lowercase words of three or more letters with no
 * digit (ticket numbers and ids would fill a sketch with terms no request names), stopwords out, each once.
 */
export function sketchTerms(text: string): string[] {
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
