/**
 * One user's item vectors as int8 codes (F2, docs/research/f2-semantic-pool.md §5a): each vector, optionally projected
 * (`Projection`: mean removed, then a d × D matrix), is stored as `d` int8 values and one float scale, in typed arrays
 * that grow by doubling (no object per item). With a 128-dimension projection a 3,000-item user holds about 0.38 MB
 * plus the ids; with none, 384 bytes an item. Binary codes lost the measured gain (dev20 +2 against +20), so none are
 * offered. A removed item's slot is reused.
 */

/** A linear projection: `(v − mean) · matrix`, `matrix` row-major D × d. */
export interface Projection {
  mean: Float32Array;
  matrix: Float32Array;
  /** Output dimensions. */
  dims: number;
}

/** `v` projected (or copied when there is no projection). */
export function project(v: Float32Array, p: Projection | null): Float32Array {
  if (!p) return v;
  const D = p.mean.length;
  const out = new Float32Array(p.dims);
  for (let i = 0; i < D; i++) {
    const x = v[i]! - p.mean[i]!;
    if (x === 0) continue;
    const row = i * p.dims;
    for (let j = 0; j < p.dims; j++) out[j]! += x * p.matrix[row + j]!;
  }
  return out;
}

export class UserCodes {
  private codes: Int8Array;
  private scales: Float32Array;
  /** Per slot, the caller's 32-bit stamp of the text the code was made from (`stampOf`: skip an unchanged item). */
  private stamps: Uint32Array;
  private ids: (string | undefined)[] = [];
  private readonly slot = new Map<string, number>();
  private free: number[] = [];

  constructor(
    /** Dimensions of a code (the projection's output, or the vector's own). */
    readonly dims: number,
    capacity = 64,
  ) {
    this.codes = new Int8Array(capacity * dims);
    this.scales = new Float32Array(capacity);
    this.stamps = new Uint32Array(capacity);
  }

  /** The stamp an item's code was stored with, or undefined when it holds none. */
  stampOf(id: string): number | undefined {
    const at = this.slot.get(id);
    return at === undefined ? undefined : this.stamps[at];
  }

  get size(): number {
    return this.slot.size;
  }

  has(id: string): boolean {
    return this.slot.has(id);
  }

  /** Bytes the codes and scales take (their arrays' capacity), the ids aside. */
  get bytes(): number {
    return this.codes.byteLength + this.scales.byteLength + this.stamps.byteLength;
  }

  /** Stores (or replaces) an item's code from its projected vector. */
  put(id: string, v: Float32Array, stamp = 0): void {
    if (v.length !== this.dims) throw new Error(`encoder: a code has ${this.dims} dimensions, not ${v.length}`);
    let at = this.slot.get(id);
    if (at === undefined) {
      at = this.free.pop() ?? this.ids.length;
      if (at >= this.scales.length) this.grow();
      this.slot.set(id, at);
      this.ids[at] = id;
    }
    let max = 0;
    for (let d = 0; d < this.dims; d++) max = Math.max(max, Math.abs(v[d]!));
    const scale = max / 127 || 1;
    this.scales[at] = scale;
    this.stamps[at] = stamp >>> 0;
    const base = at * this.dims;
    for (let d = 0; d < this.dims; d++) this.codes[base + d] = Math.round(v[d]! / scale);
  }

  remove(id: string): void {
    const at = this.slot.get(id);
    if (at === undefined) return;
    this.slot.delete(id);
    this.ids[at] = undefined;
    this.free.push(at);
  }

  /**
   * The `k` stored ids with the highest dot product with `q` (projected, full precision), best first; `keep` filters
   * ids (a caller's live-items check).
   */
  top(q: Float32Array, k: number, keep: (id: string) => boolean = () => true): string[] {
    if (q.length !== this.dims) throw new Error(`encoder: a query has ${this.dims} dimensions, not ${q.length}`);
    const best: { id: string; s: number }[] = [];
    for (let at = 0; at < this.ids.length; at++) {
      const id = this.ids[at];
      if (id === undefined || !keep(id)) continue;
      const base = at * this.dims;
      let s = 0;
      for (let d = 0; d < this.dims; d++) s += this.codes[base + d]! * q[d]!;
      s *= this.scales[at]!;
      if (best.length < k) best.push({ id, s });
      else if (s > best[best.length - 1]!.s) best[best.length - 1] = { id, s };
      else continue;
      best.sort((a, b) => b.s - a.s);
    }
    return best.map((x) => x.id);
  }

  private grow(): void {
    const codes = new Int8Array(this.codes.length * 2 || this.dims * 64);
    codes.set(this.codes);
    this.codes = codes;
    const scales = new Float32Array(this.scales.length * 2 || 64);
    scales.set(this.scales);
    this.scales = scales;
    const stamps = new Uint32Array(scales.length);
    stamps.set(this.stamps);
    this.stamps = stamps;
  }
}
