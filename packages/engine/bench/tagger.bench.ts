/**
 * The constraint tagger's cost (D908): load time and resident memory of the shared weights, and µs an item over one
 * the weights' own check items (generated worlds, 16 items of 0.4-3 KB, cycled) — the per-item CPU an ingest pays.
 *
 *   bun packages/engine/bench/tagger.bench.ts
 */
import { readTagger, TAGGER_PATH } from "../src/tagger";

Bun.gc(true);
const rss0 = process.memoryUsage().rss;
let t = performance.now();
const tagger = readTagger(TAGGER_PATH)!;
const loadMs = performance.now() - t;
Bun.gc(true);
const rssMb = (process.memoryUsage().rss - rss0) / 2 ** 20;
const checks = tagger.header.checks.map((c) => ({ title: "", text: c.text }));
const items = Array.from({ length: 1_600 }, (_, i) => checks[i % checks.length]!);
for (const it of items.slice(0, 50)) tagger.factProbability(it); // warm-up
const runs: number[] = [];
for (let r = 0; r < 3; r++) {
  t = performance.now();
  for (const it of items) tagger.factProbability(it);
  runs.push(((performance.now() - t) * 1000) / items.length);
}
runs.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    items: items.length,
    meanChars: Math.round(checks.reduce((n, c) => n + c.text.length, 0) / checks.length),
    loadMs: +loadMs.toFixed(1),
    rssMb: +rssMb.toFixed(1),
    usPerItem: { min: +runs[0]!.toFixed(1), median: +runs[1]!.toFixed(1), max: +runs[2]!.toFixed(1) },
  }),
);
