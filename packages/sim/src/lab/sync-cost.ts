#!/usr/bin/env bun
/**
 * What holding a synced index costs (D56, docs/research/moon-sync.md): twelve simulated users' sources backfilled
 * through the real `SyncManager`; prints the heap they add (after a full GC) and the CPU time of their backfill.
 *
 *   bun packages/sim/src/lab/sync-cost.ts
 */
import { ContextPartner, ItemCache } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { REALISTIC, simSources } from "../sources";
import { buildWorld } from "../world";

const N = 12;
const worlds = Array.from({ length: N }, (_, i) => buildWorld({ seed: 41_000 + i }));
const cache = new ItemCache();
let clock = worlds[0]!.now - 30 * 60_000;
const srcs = worlds.map((w, i) => simSources(w, REALISTIC, 0, i));
const partner = new ContextPartner({
  sources: async (s) => srcs[Number(s.userId)]!,
  sourceMap: new SourceMap(":memory:", { seed: 1 }),
  cache,
  budget: new Budget(),
  model: null,
  now: () => clock,
  config: { sync: true },
});
Bun.gc(true);
const h0 = process.memoryUsage().heapUsed;
const c0 = process.cpuUsage();
for (let u = 0; u < N; u++) partner.sync!.track({ tenantId: "t", userId: String(u) }, clock);
for (let i = 0; i < 30; i++) {
  await partner.sync!.tick();
  clock += 60_000;
}
const c1 = process.cpuUsage(c0);
Bun.gc(true);
const h1 = process.memoryUsage().heapUsed;
const items = Array.from({ length: N }, (_, u) => cache.syncedCount({ tenantId: "t", userId: String(u) }));
console.log(
  `users ${N}, synced items ${items.reduce((a, b) => a + b, 0)}, heap +${((h1 - h0) / 1e6).toFixed(1)} MB ` +
    `(${((h1 - h0) / 1e3 / N).toFixed(0)} KB/user), CPU ${((c1.user + c1.system) / 1e3 / N).toFixed(0)} ms/user`,
);
