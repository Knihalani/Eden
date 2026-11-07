/**
 * `Histogram` / `RollingHistogram` (histogram.ts): record and quantile time, and heap per rolling histogram by how many
 * samples it holds. The fan-out keeps one (two with the planner) per (user, source) pair it has called, up to 100,000
 * pairs per process, so a user with 1,000 connectors holds 1,000 of them (A1 scale audit, D261).
 *
 *   bun packages/primitives/bench/histogram.bench.ts
 */
import { Histogram, RollingHistogram } from "../src/histogram";
import { bench, consume, report } from "./harness";

const r = (() => {
  let a = 7;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();
const latency = () => 20 + 400 * r() ** 3;

const results = [];
const busy = new Histogram();
for (let i = 0; i < 1_000; i++) busy.record(latency());
results.push(bench("record (1,000 held)", () => busy.record(latency()), { batch: 1_000 }));
results.push(bench("quantile p95 (1,000 held)", () => busy.quantile(0.95)));
const few = new Histogram();
for (let i = 0; i < 5; i++) few.record(latency());
results.push(bench("quantile p95 (5 held)", () => few.quantile(0.95)));
let t = 0;
const rolling = new RollingHistogram(60_000, () => t);
for (let i = 0; i < 200; i++) rolling.record(latency());
results.push(
  bench("rolling record+quantile", () => {
    t += 7;
    rolling.record(latency());
    return rolling.quantile(0.95);
  }),
);
report(results);

// Heap per rolling histogram holding n samples, over 10,000 instances (forced GC before and after).
for (const n of [0, 1, 5, 50]) {
  Bun.gc(true);
  const before = process.memoryUsage().heapUsed;
  const held: RollingHistogram[] = [];
  for (let k = 0; k < 10_000; k++) {
    const h = new RollingHistogram(60_000, () => 0);
    for (let i = 0; i < n; i++) h.record(latency());
    held.push(h);
  }
  Bun.gc(true);
  const after = process.memoryUsage().heapUsed;
  consume(held);
  console.log(
    `heap per RollingHistogram, ${String(n).padStart(2)} samples: ${Math.round((after - before) / 10_000)} B`,
  );
}
