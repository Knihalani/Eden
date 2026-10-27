/**
 * Hit ratio and throughput of S3FifoCache against LRU (a Map, and the lru-cache package). lru-cache is not a repo
 * dependency: install it in a scratch directory (`bun add lru-cache@11`) and point the import there, or run
 * `bun add -d lru-cache@11` locally without committing it.
 */
import { LRUCache } from "lru-cache";
import { S3FifoCache } from "../../src/cache";
import { bench, report } from "../harness";

class MapLru<K, V> {
  private m = new Map<K, V>();
  constructor(private cap: number) {}
  get(k: K) {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  set(k: K, v: V) {
    this.m.delete(k);
    this.m.set(k, v);
    if (this.m.size > this.cap) this.m.delete(this.m.keys().next().value as K);
  }
}
// Zipf trace over `keys` keys with exponent `s` (inverse-CDF sampling over a precomputed table).
function zipf(keys: number, s: number, n: number, seed = 1): Int32Array {
  const cdf = new Float64Array(keys);
  let sum = 0;
  for (let i = 0; i < keys; i++) {
    sum += 1 / Math.pow(i + 1, s);
    cdf[i] = sum;
  }
  let x = seed;
  const out = new Int32Array(n);
  for (let j = 0; j < n; j++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    const u = (x / 2 ** 32) * sum;
    let lo = 0,
      hi = keys - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid]! < u) lo = mid + 1;
      else hi = mid;
    }
    out[j] = lo;
  }
  return out;
}
// One-hit-wonder heavy trace: Zipf hot set mixed with 50% never-repeated keys (like one-off lookups).
function mixed(n: number): Int32Array {
  const z = zipf(10_000, 1.0, n, 3);
  const out = new Int32Array(n);
  let unique = 1_000_000;
  for (let i = 0; i < n; i++) out[i] = i % 2 === 0 ? z[i]! : unique++;
  return out;
}

const N = 400_000;
for (const [label, trace, cap] of [
  ["zipf 0.8, 100k keys, cache 10k", zipf(100_000, 0.8, N), 10_000],
  ["zipf 1.0, 100k keys, cache 1k", zipf(100_000, 1.0, N), 1_000],
  ["50% one-hit wonders + zipf hot set, cache 1k", mixed(N), 1_000],
] as const) {
  const caches = {
    "S3FifoCache (ours)": new S3FifoCache<number, number>({ maxBytes: cap }),
    "Map LRU": new MapLru<number, number>(cap),
    "lru-cache@11": new LRUCache<number, number>({ max: cap }),
  };
  console.log(`\n${label}`);
  for (const [name, c] of Object.entries(caches)) {
    let hits = 0;
    for (let i = 0; i < trace.length; i++) {
      const k = trace[i]!;
      const v = (c as any).get(k);
      if (v !== undefined) hits++;
      else (c as any).set(k, k);
    }
    console.log(`  ${name.padEnd(20)} hit ratio ${(hits / trace.length).toFixed(4)}`);
  }
}
// Throughput: get+set on a zipf trace
const trace = zipf(100_000, 0.9, 1 << 16);
const s3 = new S3FifoCache<number, number>({ maxBytes: 10_000 });
const lru = new MapLru<number, number>(10_000);
const lc = new LRUCache<number, number>({ max: 10_000 });
let p = 0;
report([
  bench(
    "S3FifoCache get/set",
    () => {
      const k = trace[p++ & 0xffff]!;
      const v = s3.get(k);
      if (v === undefined) s3.set(k, k);
      return v;
    },
    { batch: 1000 },
  ),
  bench(
    "Map LRU get/set",
    () => {
      const k = trace[p++ & 0xffff]!;
      const v = lru.get(k);
      if (v === undefined) lru.set(k, k);
      return v;
    },
    { batch: 1000 },
  ),
  bench(
    "lru-cache@11 get/set",
    () => {
      const k = trace[p++ & 0xffff]!;
      const v = lc.get(k);
      if (v === undefined) lc.set(k, k);
      return v;
    },
    { batch: 1000 },
  ),
]);
