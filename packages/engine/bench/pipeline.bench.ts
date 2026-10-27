/**
 * End to end: a realistic event stream through the real ContextPartner (fast path, slow path, source search, cache
 * writes, redaction, tokenizing, scoring, rendering), with instant sources so only Eden's CPU is measured. This is the
 * anchor for performance work: a primitive change that does not move these numbers (or the eval) is not worth its
 * complexity. Reports per-event latency of `observe` (fast path, waitMs 0), the CPU cost of slow-path lookups, and
 * event-loop lag while the stream runs.
 *
 *   bun packages/engine/bench/pipeline.bench.ts [itemsPerSource=1500] [events=2000] [gateWorkers=0]
 *
 * With gateWorkers > 0, lookup results are redacted in a WorkerPool (D25) and each event waits for the pool to drain.
 * The stream is sequential, so this shows the pool's overhead and that decisions do not change, not the tail latency
 * it buys other users under concurrent load (primitives/bench/offload.bench.ts measures that).
 */
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { WorkerPool } from "@eden/primitives";
import { ContextPartner, GATE_MODULE, ItemCache, type Trace } from "../src/index";
import { buildWorkload } from "./workload";

const itemsPerSource = Number(process.argv[2] ?? 1_500);
const eventCount = Number(process.argv[3] ?? 2_000);
const gateWorkers = Number(process.argv[4] ?? 0);
const w = buildWorkload({ itemsPerSource, events: eventCount, seed: 7 });
const pool =
  gateWorkers > 0
    ? await WorkerPool.start({
        module: GATE_MODULE,
        size: gateWorkers,
        maxQueue: 4_096,
        maxBatch: 32,
        taskTimeoutMs: 500,
        inlineBelow: 1_024,
      })
    : undefined;

const traces: Trace[] = [];
const partner = new ContextPartner({
  sources: async () => w.sources,
  sourceMap: new SourceMap(),
  cache: new ItemCache(),
  budget: new Budget(),
  model: null,
  onTrace: (t) => traces.push(t),
  gatePool: pool,
});

// Event-loop lag probe: a 1 ms interval; lag = how late it fires.
const lags: number[] = [];
let expected = performance.now() + 1;
const probe = setInterval(() => {
  const now = performance.now();
  lags.push(Math.max(0, now - expected));
  expected = now + 1;
}, 1);

const observeMs: number[] = [];
const slowMs: number[] = [];
const t0 = performance.now();
for (const event of w.events) {
  const s = performance.now();
  await partner.observe(event, { waitMs: 0 });
  observeMs.push(performance.now() - s);
  // Let the slow path run to completion (sources are instant), and time it as CPU spent before the next event.
  const s2 = performance.now();
  await Bun.sleep(0);
  while (pool && (pool.stats().busy > 0 || pool.stats().queued > 0)) await Bun.sleep(0);
  if (pool) await Bun.sleep(0);
  slowMs.push(performance.now() - s2);
}
const total = performance.now() - t0;
clearInterval(probe);
const poolStats = pool?.stats();
pool?.close();

const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
const fmt = (ms: number) => `${(ms * 1000).toFixed(1)} µs`;
const decisions: Record<string, number> = {};
for (const t of traces) decisions[t.decision] = (decisions[t.decision] ?? 0) + 1;
console.log(`workload: ${w.items} items across ${w.sources.length} sources, ${w.events.length} events`);
console.log(
  `observe (fast path):  p50 ${fmt(pct(observeMs, 0.5))}  p99 ${fmt(pct(observeMs, 0.99))}  max ${fmt(Math.max(...observeMs))}`,
);
console.log(
  `slow path per event:  p50 ${fmt(pct(slowMs, 0.5))}  p99 ${fmt(pct(slowMs, 0.99))}  max ${fmt(Math.max(...slowMs))}`,
);
console.log(
  `event-loop lag:       p50 ${fmt(pct(lags, 0.5))}  p99 ${fmt(pct(lags, 0.99))}  max ${fmt(Math.max(...lags))}`,
);
console.log(`total ${total.toFixed(0)} ms, ${(total / w.events.length).toFixed(3)} ms/event`);
console.log("decisions", JSON.stringify(decisions));
if (poolStats) console.log("pool", JSON.stringify(poolStats));
