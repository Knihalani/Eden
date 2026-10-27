/**
 * Concurrent load through the real ContextPartner: many users, each with cold caches, sending events open-loop at a
 * fixed total rate, so a lookup's synchronous work (redaction, tokenizing, indexing) delays everyone else's events.
 * Compares gating lookup results on the event loop with gating them in a WorkerPool (D25). Instant sources, no model.
 *
 *   bun packages/engine/bench/concurrent.bench.ts [eventsPerSec=400] [seconds=8] [gateWorkers=0] [users=200]
 *                                                 [sourceMs=50-250]
 *
 * Sources answer after a uniform random delay in `sourceMs` (a real MCP source takes tens to hundreds of ms; with
 * 0 every lookup's work lands in one synchronous burst, which no real deployment sees). The CPU is Eden's own.
 *
 * Reports `observe` latency (waitMs 0: what an agent waits for on every event), event-loop lag, and how many
 * lookups finished. pipeline.bench.ts is the sequential anchor; this is the multi-user one.
 */
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { WorkerPool } from "@eden/primitives";
import type { AgentEvent } from "@eden/protocol";
import { SourceFanout, type Source } from "@eden/sources";
import { ContextPartner, GATE_MODULE, ItemCache, pooledSanitizer, type Trace } from "../src/index";
import { buildWorkload } from "./workload";

const rate = Number(process.argv[2] ?? 400);
const seconds = Number(process.argv[3] ?? 8);
const gateWorkers = Number(process.argv[4] ?? 0);
const users = Number(process.argv[5] ?? 200);
const [minMs, maxMs] = (process.argv[6] ?? "50-250").split("-").map(Number) as [number, number];

const total = Math.round(rate * seconds);
const w = buildWorkload({ itemsPerSource: 1_500, events: Math.ceil(total / users) + 40, seed: 7 });
let delay = 1;
const nextDelay = () => {
  delay = (Math.imul(delay, 1103515245) + 12345) >>> 0;
  return minMs + (((delay >>> 8) % 1_000) / 1_000) * ((maxMs ?? minMs) - minMs);
};
const sources: Source[] = w.sources.map((src) => ({
  id: src.id,
  kind: src.kind,
  description: src.description,
  async search(query, signal) {
    const items = await src.search(query, signal);
    await Bun.sleep(nextDelay());
    return items;
  },
}));

// Each user replays the same session stream under its own id: same work per user, no shared cache.
const perUser = Math.ceil(total / users);
const events: AgentEvent[] = [];
for (let i = 0; i < perUser; i++) {
  for (let u = 0; u < users && events.length < total; u++) {
    const e = w.events[i]!;
    events.push({ ...e, userId: `u${u}`, sessionId: `u${u}-${e.sessionId}` } as AgentEvent);
  }
}

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
  sources: async () => sources,
  sourceMap: new SourceMap(),
  cache: new ItemCache({ maxUsersPerTenant: users }),
  budget: new Budget(),
  model: null,
  onTrace: (t) => traces.push(t),
  fanout: pool && new SourceFanout({ sanitize: pooledSanitizer(pool) }),
  config: { maxSessionsPerTenant: users * 4 },
});

const t0 = performance.now();
// Steady state starts once every user has had a first lookup (a cold start sends all of them at once).
const warmupMs = Math.min(seconds * 500, (users / rate) * 1_000 * 4);
const lags: number[] = [];
const steadyLags: number[] = [];
let expected = performance.now() + 1;
const probe = setInterval(() => {
  const now = performance.now();
  lags.push(Math.max(0, now - expected));
  if (now - t0 > warmupMs) steadyLags.push(Math.max(0, now - expected));
  expected = now + 1;
}, 1);

const observeMs: number[] = [];
const steadyMs: number[] = [];
const inflight: Promise<unknown>[] = [];
const cpu0 = process.cpuUsage();
const gap = 1_000 / rate;
for (let i = 0; i < events.length; i++) {
  const due = t0 + i * gap;
  // Open loop: an event is sent when due, whether or not earlier ones finished.
  while (performance.now() < due) await Bun.sleep(Math.max(0, due - performance.now() - 0.5));
  const sent = performance.now();
  inflight.push(
    partner.observe(events[i]!, { waitMs: 0 }).then(() => {
      observeMs.push(performance.now() - sent);
      if (sent - t0 > warmupMs) steadyMs.push(performance.now() - sent);
    }),
  );
}
await Promise.all(inflight);
await Bun.sleep(200); // Let trailing lookups finish.
const elapsed = performance.now() - t0;
clearInterval(probe);
const cpu = process.cpuUsage(cpu0);
const poolStats = pool?.stats();
pool?.close();

const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
const fmt = (ms: number) => `${ms.toFixed(2)} ms`;
const decisions: Record<string, number> = {};
for (const t of traces) decisions[t.decision] = (decisions[t.decision] ?? 0) + 1;
console.log(
  `${events.length} events at ${rate}/s over ${users} users, sources ${minMs}-${maxMs} ms, gate ${gateWorkers ? `pool ${gateWorkers}` : "inline"}`,
);
console.log(
  `observe: p50 ${fmt(pct(observeMs, 0.5))}  p99 ${fmt(pct(observeMs, 0.99))}  max ${fmt(Math.max(...observeMs))}`,
);
console.log(`lag:     p50 ${fmt(pct(lags, 0.5))}  p99 ${fmt(pct(lags, 0.99))}  max ${fmt(Math.max(...lags))}`);
console.log(
  `steady (after ${(warmupMs / 1_000).toFixed(1)} s): observe p99 ${fmt(pct(steadyMs, 0.99))}  ` +
    `max ${fmt(Math.max(...steadyMs))}; lag p99 ${fmt(pct(steadyLags, 0.99))}  max ${fmt(Math.max(...steadyLags))}`,
);
console.log(
  `elapsed ${elapsed.toFixed(0)} ms; process CPU ${(((cpu.user + cpu.system) / 1_000 / elapsed) * 100).toFixed(0)}%`,
);
console.log("decisions", JSON.stringify(decisions));
if (poolStats) console.log("pool", JSON.stringify(poolStats));
