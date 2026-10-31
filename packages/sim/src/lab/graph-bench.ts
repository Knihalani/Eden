#!/usr/bin/env bun
/**
 * The knowledge graph's cost (docs/research/moon-graph.md): for each seed's world with every dev suite planted and
 * every source item synced into the cache (the `--sync` funnel's state), how long building the user's graph takes per
 * item, how many nodes it holds, and the CPU time of one walk per request (each request walked `--reps` times, the
 * walk as the engine runs it: `seedsOf` from the request's names and days, `graphBudgetMs` 2 ms).
 *
 *   bun packages/sim/src/lab/graph-bench.ts [--seeds 41,42,43,44] [--reps 50]
 *
 * Wall time on a shared machine is noisy; CPU time (`process.cpuUsage`) over all walks is reported beside it.
 */
import { extractEntities, ItemCache, seedsOf, timeWindow } from "@eden/engine";
import { REALISTIC, simSources } from "../sources";
import { buildWorld } from "../world";
import { clearSlot, dress } from "./hidden-context";
import { SUITES } from "./suites";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const SEEDS = opt("seeds", "41,42,43,44").split(",").map(Number);
const REPS = Number(opt("reps", "50"));
const DEV = ["hidden", "heldout", "heldout2", "heldout3", "heldout4"];

const walks: number[] = [];
let cpuMicros = 0;
let items = 0;
let buildMs = 0;
let nodes = 0;
for (const seed of SEEDS) {
  const world = buildWorld({ seed: seed * 1_000 });
  const requests: string[] = [];
  for (const suite of DEV) {
    const before = world.items.length;
    const tasks = SUITES[suite]!(world, seed, "hidden");
    for (const it of world.items.slice(before)) dress(world, it);
    const keep = new Set(world.items.slice(before).map((it) => it.id));
    for (const t of tasks) clearSlot(world, t.text, keep);
    requests.push(...tasks.map((t) => t.text));
  }
  const all = simSources(world, REALISTIC, 0, seed).flatMap((s) => s.listAll());
  const cache = new ItemCache();
  cache.enableGraph();
  const scope = { tenantId: "bench", userId: `w${seed}` };
  cache.put(scope, all, world.now);
  // The graph's share of storing them: the same items put with and without a graph, the difference.
  const timePut = (graph: boolean) => {
    const c = new ItemCache();
    if (graph) c.enableGraph();
    const t0 = performance.now();
    c.put(scope, all, world.now);
    return performance.now() - t0;
  };
  timePut(false);
  buildMs += Math.max(0, timePut(true) - timePut(false));
  items += all.length;
  nodes += cache.graphSize(scope);
  const opts = { budgetMs: 2, limit: 16, floor: 0.15 };
  for (const text of requests) {
    const seeds = seedsOf(text, extractEntities(text), timeWindow(text, world.now)?.days ?? []);
    cache.walk(scope, seeds, opts, world.now); // Warm.
    const c0 = process.cpuUsage();
    for (let r = 0; r < REPS; r++) {
      const w0 = performance.now();
      cache.walk(scope, seeds, opts, world.now);
      walks.push((performance.now() - w0) * 1_000);
    }
    const c = process.cpuUsage(c0);
    cpuMicros += c.user + c.system;
  }
}
walks.sort((a, b) => a - b);
const q = (p: number) => walks[Math.min(walks.length - 1, Math.floor(p * walks.length))]!;
console.log(
  JSON.stringify(
    {
      seeds: SEEDS,
      items,
      graphMsPerItem: Number((buildMs / items).toFixed(4)),
      nodesPerUser: Math.round(nodes / SEEDS.length),
      walks: walks.length,
      walkMicros: {
        p50: Math.round(q(0.5)),
        p95: Math.round(q(0.95)),
        p99: Math.round(q(0.99)),
        max: Math.round(q(1)),
      },
      walkCpuMicrosMean: Math.round(cpuMicros / walks.length),
    },
    null,
    2,
  ),
);
