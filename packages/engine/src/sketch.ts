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
import { isStopword } from "./text";

/** The sketch's size while it fills (bits, a power of two). */
const MAX_BITS = 1 << 15;
/** The smallest it folds to. */
const MIN_BITS = 1 << 10;
/** Folding stops before the fill passes this: past it a k = 2 filter's false matches pass ~4%. */
const FOLD_FILL = 0.2;
/** A fill past this restarts the sketch: a k = 2 filter half full matches a quarter of the terms it never saw. */
const SATURATED = 0.5;
/**
 * The same two bounds for a sketch of four probes (`sourceYieldEarn`, D600: `Sync.sketchRare` asks which few of a
 * thousand sketches hold a word, so one false match in 25 would name forty sources). At a fill of 0.15 four probes
 * match about one unseen term in 2,000; at 0.35, one in 70.
 */
const FOLD_FILL_4 = 0.15;
const SATURATED_4 = 0.35;

export class TermSketch {
  private bits = new Uint32Array(MAX_BITS / 32);
  private set = 0;

  /** `probes`: bits a term sets, 2 (the default, D322) or 4 (`sourceYieldEarn`: about twice the bytes a term). */
  constructor(readonly probes: 2 | 4 = 2) {}

  /** Whether one more term could restart the sketch (`add`): a caller that cannot re-list the source stops adding. */
  get full(): boolean {
    return this.set > (this.probes === 4 ? SATURATED_4 : SATURATED) * this.bits.length * 32;
  }

  /** Bytes held. */
  get bytes(): number {
    return this.bits.byteLength;
  }

  /** Adds a term by its two hashes (`termHashes`). */
  add(h1: number, h2: number): void {
    // Saturated (a folded sketch whose source grew, or a busy one): it would match every term, so it starts again,
    // full size, from what comes next (the daily sweep re-lists the source). The review measured 96% false matches.
    if (this.full) {
      this.bits = new Uint32Array(MAX_BITS / 32);
      this.set = 0;
    }
    const mask = this.bits.length * 32 - 1;
    this.setBit(h1 & mask);
    this.setBit((h1 + h2) & mask);
    if (this.probes === 4) {
      this.setBit((h1 + 2 * h2) & mask);
      this.setBit((h1 + 3 * h2) & mask);
    }
  }

  /** Whether the term may be in the sketch (never false for one added). */
  has(h1: number, h2: number): boolean {
    const mask = this.bits.length * 32 - 1;
    if (!this.bit(h1 & mask) || !this.bit((h1 + h2) & mask)) return false;
    return this.probes === 2 || (this.bit((h1 + 2 * h2) & mask) && this.bit((h1 + 3 * h2) & mask));
  }

  /** Halves the sketch while the fill after halving stays under `FOLD_FILL`. Terms added keep matching. */
  fold(): void {
    for (;;) {
      const n = this.bits.length;
      if (n * 32 <= MIN_BITS) return;
      const f = this.set / (n * 32);
      if (1 - (1 - f) * (1 - f) > (this.probes === 4 ? FOLD_FILL_4 : FOLD_FILL)) return;
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
  dump(): { bits: string; set: number; probes?: 4 } {
    return {
      bits: Buffer.from(this.bits.buffer, this.bits.byteOffset, this.bits.byteLength).toString("base64"),
      set: this.set,
      // Only when not the default, so a default sketch is saved as it always was.
      ...(this.probes === 4 ? { probes: 4 as const } : {}),
    };
  }

  /**
   * A sketch from `dump`'s output, or null when it is not one (a power-of-two size within the bounds) or was filled
   * with another number of probes than `probes`: read with more, it would deny terms it holds, so it starts again.
   */
  static load(d: unknown, probes: 2 | 4 = 2): TermSketch | null {
    const x = d as { bits?: unknown; set?: unknown; probes?: unknown } | null;
    if (typeof x?.bits !== "string" || typeof x.set !== "number") return null;
    if ((x.probes ?? 2) !== probes) return null;
    const bytes = Buffer.from(x.bits, "base64");
    const words = bytes.byteLength / 4;
    if (!Number.isInteger(words) || words * 32 < MIN_BITS || words * 32 > MAX_BITS || (words & (words - 1)) !== 0) {
      return null;
    }
    const t = new TermSketch(probes);
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
