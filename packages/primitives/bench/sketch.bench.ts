/**
 * Does a compact structure beat the plain Set/Map at Eden's scale? Two workloads, each with its obvious alternative:
 *
 * 1. Delivered history ("was this item already given to this user in the last 7 days?"): 7 daily windows, items
 *    keyed by a 64-bit content fingerprint, per user 2k live keys (today's item cache size) or 100k (a heavy
 *    user's year of mail), ~32 lookups per delivery decision. Candidates: ExpiringSet (sketch.ts), a Map of
 *    key → day with a sweep per rotation, seven Set generations, seven rotating Bloom filters at 0.1%.
 * 2. Recurrence counting ("has this unseen name appeared twice?", for promoting gazetteer candidates): a Zipf
 *    stream of name candidates per user. Candidates: an exact Map, a count-min sketch with conservative update at
 *    a tenth of the Map's memory.
 *
 * Memory of JS containers is measured from JSC heap stats (heap + extra memory) over many live instances; typed
 * structures report their array bytes.
 *
 *   bun packages/primitives/bench/sketch.bench.ts
 */
import { heapStats } from "bun:jsc";
import { mix32 } from "../src/hash";
import { ExpiringSet } from "../src/sketch";
import { bench, consume, report } from "./harness";

// --- Candidates that are not in src (they have to earn it here first). ---

/** Bloom filter with enhanced double hashing over two 32-bit lanes; m from n and the target false-positive rate. */
class Bloom {
  readonly bits: Uint32Array;
  readonly m: number;
  readonly k: number;
  constructor(n: number, fpr: number) {
    this.m = Math.max(64, Math.ceil((-n * Math.log(fpr)) / (Math.LN2 * Math.LN2)));
    this.k = Math.max(1, Math.round((this.m / n) * Math.LN2));
    this.bits = new Uint32Array(Math.ceil(this.m / 32));
  }
  add(lo: number, hi: number): void {
    let a = mix32(lo) % this.m;
    let b = (mix32(hi ^ 0x9e3779b9) % (this.m - 1)) + 1;
    for (let i = 0; i < this.k; i++) {
      this.bits[a >>> 5]! |= 1 << (a & 31);
      a = (a + b) % this.m;
      b = (b + i + 1) % this.m;
    }
  }
  has(lo: number, hi: number): boolean {
    let a = mix32(lo) % this.m;
    let b = (mix32(hi ^ 0x9e3779b9) % (this.m - 1)) + 1;
    for (let i = 0; i < this.k; i++) {
      if ((this.bits[a >>> 5]! & (1 << (a & 31))) === 0) return false;
      a = (a + b) % this.m;
      b = (b + i + 1) % this.m;
    }
    return true;
  }
}

/** Count-min sketch with conservative update (Estan & Varghese): raise each row only up to the new minimum. */
class CountMin {
  readonly table: Uint32Array;
  constructor(
    readonly width: number,
    readonly depth: number,
  ) {
    this.table = new Uint32Array(width * depth);
  }
  private index(lo: number, hi: number, row: number): number {
    return row * this.width + (mix32((lo + Math.imul(row + 1, hi)) | 0) % this.width);
  }
  add(lo: number, hi: number): number {
    let min = 0xffffffff;
    for (let r = 0; r < this.depth; r++) min = Math.min(min, this.table[this.index(lo, hi, r)]!);
    const target = min + 1;
    for (let r = 0; r < this.depth; r++) {
      const i = this.index(lo, hi, r);
      if (this.table[i]! < target) this.table[i] = target;
    }
    return target;
  }
  estimate(lo: number, hi: number): number {
    let min = 0xffffffff;
    for (let r = 0; r < this.depth; r++) min = Math.min(min, this.table[this.index(lo, hi, r)]!);
    return min;
  }
}

/** The JS baselines for delivered history. */
class MapHistory {
  private readonly m = new Map<number, number>();
  private day = 0;
  constructor(readonly windows: number) {}
  has(key: number): boolean {
    const d = this.m.get(key);
    return d !== undefined && d > this.day - this.windows;
  }
  add(key: number): void {
    this.m.delete(key); // re-insert: Map order stays oldest first, so the sweep stops early
    this.m.set(key, this.day);
  }
  rotate(): void {
    this.day++;
    for (const [k, d] of this.m) {
      if (d > this.day - this.windows) break;
      this.m.delete(k);
    }
  }
  get size(): number {
    return this.m.size;
  }
}

class SetGenerations {
  private gens: Set<number>[];
  constructor(readonly windows: number) {
    this.gens = [new Set()];
  }
  has(key: number): boolean {
    for (const g of this.gens) if (g.has(key)) return true;
    return false;
  }
  add(key: number): void {
    this.gens[this.gens.length - 1]!.add(key);
  }
  rotate(): void {
    this.gens.push(new Set());
    if (this.gens.length > this.windows) this.gens.shift();
  }
}

class BloomGenerations {
  private gens: Bloom[];
  constructor(
    readonly windows: number,
    readonly perWindow: number,
    readonly fpr: number,
  ) {
    this.gens = [new Bloom(perWindow, fpr)];
  }
  has(lo: number, hi: number): boolean {
    for (const g of this.gens) if (g.has(lo, hi)) return true;
    return false;
  }
  add(lo: number, hi: number): void {
    this.gens[this.gens.length - 1]!.add(lo, hi);
  }
  rotate(): void {
    this.gens.push(new Bloom(this.perWindow, this.fpr));
    if (this.gens.length > this.windows) this.gens.shift();
  }
  get bytes(): number {
    return this.gens.reduce((s, g) => s + g.bits.byteLength, 0);
  }
}

// --- Workload 1: delivered history. ---

let seed = 12345;
const rnd = () => (seed = mix32((seed + 0x9e3779b9) | 0));
const WINDOWS = 7;
/** Keys as two lanes and as the 52-bit number a JS Map would use. */
function makeKeys(n: number): { lo: Uint32Array; hi: Uint32Array; num: Float64Array } {
  const lo = new Uint32Array(n);
  const hi = new Uint32Array(n);
  const num = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lo[i] = rnd();
    hi[i] = rnd();
    num[i] = lo[i]! + (hi[i]! & 0xfffff) * 4294967296;
  }
  return { lo, hi, num };
}
const heap = () => {
  Bun.gc(true);
  Bun.gc(true);
  const h = heapStats();
  return h.heapSize + h.extraMemorySize;
};

console.log("## Delivered history: 7 daily windows, keys added evenly over 7 days (all live), exact unless noted");
for (const live of [2_000, 100_000]) {
  const perDay = Math.ceil(live / WINDOWS);
  const keys = makeKeys(live);
  const absent = makeKeys(200_000);
  const fill = <T>(make: () => T, add: (s: T, i: number) => void, rotate: (s: T) => void): T => {
    const s = make();
    for (let i = 0; i < live; i++) {
      if (i > 0 && i % perDay === 0) rotate(s);
      add(s, i);
    }
    return s;
  };
  // Memory: many live instances (users) of each JS structure.
  const users = Math.max(1, Math.round(1_000_000 / live));
  const measure = (build: () => unknown): number => {
    const before = heap();
    const all: unknown[] = [];
    for (let u = 0; u < users; u++) all.push(build());
    const bytes = (heap() - before) / (users * live);
    consume(all.length);
    return bytes;
  };
  const exp = fill(
    () => new ExpiringSet(WINDOWS, perDay),
    (s, i) => s.add(keys.lo[i]!, keys.hi[i]!),
    (s) => s.rotate(),
  );
  const map = fill(
    () => new MapHistory(WINDOWS),
    (s, i) => s.add(keys.num[i]!),
    (s) => s.rotate(),
  );
  const sets = fill(
    () => new SetGenerations(WINDOWS),
    (s, i) => s.add(keys.num[i]!),
    (s) => s.rotate(),
  );
  const bloom = fill(
    () => new BloomGenerations(WINDOWS, perDay, 0.001),
    (s, i) => s.add(keys.lo[i]!, keys.hi[i]!),
    (s) => s.rotate(),
  );
  let fp = 0;
  for (let i = 0; i < absent.lo.length; i++) if (bloom.has(absent.lo[i]!, absent.hi[i]!)) fp++;
  let expMissing = 0;
  for (let i = 0; i < live; i++) if (!exp.has(keys.lo[i]!, keys.hi[i]!)) expMissing++;
  for (let i = 0; i < absent.lo.length; i++) if (exp.has(absent.lo[i]!, absent.hi[i]!)) expMissing++;
  if (expMissing > 0 || exp.size !== live) throw new Error(`ExpiringSet wrong: ${expMissing}, size ${exp.size}`);

  const mapBytes = measure(() =>
    fill(
      () => new MapHistory(WINDOWS),
      (s, i) => s.add(keys.num[i]!),
      (s) => s.rotate(),
    ),
  );
  const setBytes = measure(() =>
    fill(
      () => new SetGenerations(WINDOWS),
      (s, i) => s.add(keys.num[i]!),
      (s) => s.rotate(),
    ),
  );
  console.log(
    `\nlive keys ${live}: bytes per live key — ExpiringSet ${(exp.bytes / live).toFixed(1)}, ` +
      `Map key→day ${mapBytes.toFixed(1)} (measured), 7 Set generations ${setBytes.toFixed(1)} (measured), ` +
      `7 Bloom @0.1% ${(bloom.bytes / live).toFixed(2)} (measured false positives ${fp} / ${absent.lo.length})`,
  );
  let q = 0;
  const Q = 4096;
  const qmask = Q - 1;
  // Lookups: half present, half absent, as a delivery check sees them.
  const qlo = new Uint32Array(Q);
  const qhi = new Uint32Array(Q);
  const qnum = new Float64Array(Q);
  for (let i = 0; i < Q; i++) {
    const src = i % 2 === 0 ? keys : absent;
    const j = (rnd() >>> 0) % live;
    qlo[i] = src.lo[j]!;
    qhi[i] = src.hi[j]!;
    qnum[i] = src.num[j]!;
  }
  report([
    bench(`ExpiringSet has, ${live} live`, () => exp.has(qlo[q & qmask]!, qhi[q++ & qmask]!), { batch: 1000 }),
    bench(`Map key→day has, ${live} live`, () => map.has(qnum[q++ & qmask]!), { batch: 1000 }),
    bench(`7 Set generations has, ${live} live`, () => sets.has(qnum[q++ & qmask]!), { batch: 1000 }),
    bench(`7 Bloom generations has, ${live} live`, () => bloom.has(qlo[q & qmask]!, qhi[q++ & qmask]!), {
      batch: 1000,
    }),
    // A day of adds plus the rotation, amortized per add.
    bench(
      `ExpiringSet add + rotate per day, ${live} live`,
      () => {
        exp.add(qlo[q & qmask]!, qhi[q++ & qmask]!);
        if (q % perDay === 0) exp.rotate();
      },
      { batch: 1000 },
    ),
    bench(
      `Map key→day add + sweep per day, ${live} live`,
      () => {
        map.add(qnum[q++ & qmask]!);
        if (q % perDay === 0) map.rotate();
      },
      { batch: 1000 },
    ),
  ]);
}

// --- Workload 2: recurrence counting. ---

console.log("\n## Recurrence counting: Zipf(1.0) stream of candidate names, promote at count >= 2");
for (const [distinct, stream] of [
  [5_000, 20_000],
  [100_000, 400_000],
] as const) {
  const names = makeKeys(distinct);
  const cdf = new Float64Array(distinct);
  let sum = 0;
  for (let i = 0; i < distinct; i++) cdf[i] = sum += 1 / (i + 1);
  const draws = new Int32Array(stream);
  for (let i = 0; i < stream; i++) {
    const u = ((rnd() >>> 0) / 2 ** 32) * sum;
    let a = 0;
    let b = distinct - 1;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (cdf[mid]! < u) a = mid + 1;
      else b = mid;
    }
    draws[i] = a;
  }
  const exact = new Map<number, number>();
  for (let i = 0; i < stream; i++) exact.set(names.num[draws[i]!]!, (exact.get(names.num[draws[i]!]!) ?? 0) + 1);
  const before = heap();
  const copies: Map<number, number>[] = [];
  for (let c = 0; c < 10; c++) copies.push(new Map(exact));
  const mapBytes = (heap() - before) / 10;
  consume(copies.length);
  for (const fraction of [0.1, 0.25]) {
    const depth = 4;
    const width = Math.max(64, Math.floor((mapBytes * fraction) / (4 * depth)));
    const cms = new CountMin(width, depth);
    for (let i = 0; i < stream; i++) cms.add(names.lo[draws[i]!]!, names.hi[draws[i]!]!);
    let ones = 0;
    let falsePromotions = 0;
    let over = 0;
    for (let i = 0; i < distinct; i++) {
      const truth = exact.get(names.num[i]!) ?? 0;
      if (truth === 0) continue;
      const est = cms.estimate(names.lo[i]!, names.hi[i]!);
      over += est - truth;
      if (truth === 1) {
        ones++;
        if (est >= 2) falsePromotions++;
      }
    }
    console.log(
      `distinct ${distinct}, stream ${stream}: Map ${(mapBytes / 1024).toFixed(0)} KB exact; count-min ` +
        `${width}x${depth} = ${((width * depth * 4) / 1024).toFixed(0)} KB (${fraction * 100}% of the Map): ` +
        `seen-once names promoted ${falsePromotions}/${ones} (${((falsePromotions / ones) * 100).toFixed(1)}%), ` +
        `mean overcount ${(over / exact.size).toFixed(2)}`,
    );
  }
}
