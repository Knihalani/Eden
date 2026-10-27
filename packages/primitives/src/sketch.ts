/**
 * Compact membership and counting structures over 64-bit keys given as two 32-bit lanes (a fingerprint from
 * `TextSketcher.fingerprint`, or `hashString` with two seeds). Each one is here because it beat the plain `Set` or
 * `Map` at Eden's scale in bench/sketch.bench.ts; docs/research/primitives-dedup.md has the numbers and the ones that
 * did not make it.
 */
import { mix32 } from "./hash";

/**
 * "Seen in the last `windows` windows": an exact set of 64-bit keys whose entries expire a fixed number of
 * `rotate()` calls after they were last added. For "was this item already delivered to this user in the last 7
 * days" (rotate daily), or "in the last 40 turns" (rotate per turn).
 *
 * One open-addressed table of (key, generation) in typed arrays, so a lookup is one probe sequence whatever the
 * window count. 24.6–31.5 bytes per live key against 68.2–82.1 for a Map of key → day doing the same job, and no
 * sweep: `rotate` is O(1); expired entries are reused in place by inserts and dropped when the table is rebuilt.
 * Lookups cost about what a Map's do (bench/sketch.bench.ts). For a handful of keys a Map is simpler.
 */
export class ExpiringSet {
  readonly windows: number;
  private lo: Uint32Array;
  private hi: Uint32Array;
  private gen: Uint32Array; // generation the key was last added in; 0 = empty slot
  private mask: number;
  private used = 0; // occupied slots, live or expired
  private current = 1;
  private readonly perGen: Float64Array; // live entries added in each of the last `windows` generations

  constructor(windows: number, capacity: number) {
    if (!(windows >= 1)) throw new RangeError("windows must be at least 1");
    this.windows = windows;
    const size = tableSize(capacity);
    this.lo = new Uint32Array(size);
    this.hi = new Uint32Array(size);
    this.gen = new Uint32Array(size);
    this.mask = size - 1;
    this.perGen = new Float64Array(windows);
  }

  /** Live (unexpired) keys. */
  get size(): number {
    let n = 0;
    for (let g = 0; g < this.windows; g++) n += this.perGen[g]!;
    return n;
  }

  /** Bytes held by the table (typed arrays only). */
  get bytes(): number {
    return this.gen.length * 12;
  }

  /** Whether the key was added in the current window or one of the `windows - 1` before it. */
  has(lo: number, hi: number): boolean {
    lo >>>= 0;
    hi >>>= 0;
    const oldest = this.current - this.windows + 1;
    for (let i = slotOf(lo, hi) & this.mask; ; i = (i + 1) & this.mask) {
      const g = this.gen[i]!;
      if (g === 0) return false;
      if (this.lo[i] === lo && this.hi[i] === hi) return g >= oldest;
    }
  }

  /** Adds the key to the current window (refreshing it if it is already there). */
  add(lo: number, hi: number): void {
    lo >>>= 0;
    hi >>>= 0;
    const oldest = this.current - this.windows + 1;
    let reuse = -1;
    let i = slotOf(lo, hi) & this.mask;
    for (; ; i = (i + 1) & this.mask) {
      const g = this.gen[i]!;
      if (g === 0) break;
      if (this.lo[i] === lo && this.hi[i] === hi) {
        if (g >= oldest) this.perGen[g % this.windows]!--;
        this.gen[i] = this.current;
        this.perGen[this.current % this.windows]!++;
        return;
      }
      if (g < oldest && reuse < 0) reuse = i; // an expired entry: its slot can take the new key
    }
    if (reuse >= 0) {
      i = reuse;
    } else {
      if ((this.used + 1) * 4 > this.gen.length * 3) {
        this.rebuild();
        this.add(lo, hi);
        return;
      }
      this.used++;
    }
    this.lo[i] = lo;
    this.hi[i] = hi;
    this.gen[i] = this.current;
    this.perGen[this.current % this.windows]!++;
  }

  /** Starts a new window; keys last added `windows` windows ago expire. */
  rotate(): void {
    this.current++;
    this.perGen[this.current % this.windows] = 0;
  }

  /** Drops expired entries; sizes the table for the live ones (it also shrinks after a busy period). */
  private rebuild(): void {
    const oldest = this.current - this.windows + 1;
    const lo = this.lo;
    const hi = this.hi;
    const gen = this.gen;
    const size = tableSize(Math.max(16, this.size * 2));
    this.lo = new Uint32Array(size);
    this.hi = new Uint32Array(size);
    this.gen = new Uint32Array(size);
    this.mask = size - 1;
    this.used = 0;
    for (let j = 0; j < gen.length; j++) {
      if (gen[j]! < oldest) continue; // empty (0) or expired
      let i = slotOf(lo[j]!, hi[j]!) & this.mask;
      while (this.gen[i] !== 0) i = (i + 1) & this.mask;
      this.lo[i] = lo[j]!;
      this.hi[i] = hi[j]!;
      this.gen[i] = gen[j]!;
      this.used++;
    }
  }
}

/** Slots for `n` keys at load ≤ 3/4: a power of two. */
function tableSize(n: number): number {
  return 1 << Math.max(4, Math.ceil(Math.log2((Math.max(1, n) * 4) / 3 + 1)));
}

function slotOf(lo: number, hi: number): number {
  return mix32(lo ^ Math.imul(hi, 0x9e3779b1));
}
