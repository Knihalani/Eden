/**
 * O5 (docs/research/o4-new-user.md §3, the review's finding 5): one new user's backfill, alone in the process, in
 * real time. The user's first event comes at second 0 with `syncKick` on and nothing else runs: no request, no tick.
 * Connectors answer at the market profile's latency. Every 100 ms it reads how many of the user's sources have
 * their first page (or are known empty), how many are complete, and the items held. Lab only: it reads the sync's
 * private state.
 *
 *   bun packages/sim/src/lab/new-user-trace.ts [--noise 995] [--users 5] [--lanes 32] [--retry-ms 1500]
 *     [--source-profile packages/sim/lab/before-after/market-profiles/direct.json] [--max-s 200]
 *
 * `--lanes 0`: the kicked backfill in the ticks' batches (`syncBackfillLanes`, 8). `--users N`: N users one after
 * the other, each in a world and a process state of their own (seeds 41, 42, …).
 */
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { ContextPartner, ItemCache } from "@eden/engine";
import type { AgentEvent } from "@eden/protocol";
import { QueryPlanner } from "@eden/sources";
import { simSources } from "../sources";
import { buildWorld } from "../world";
import { connectorOptions } from "./connector-options";
import { noiseSources } from "./noise-sources";

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const NOISE = Number(opt("noise", "995"));
const USERS = Number(opt("users", "5"));
const LANES = Number(opt("lanes", "32"));
const RETRY_MS = Number(opt("retry-ms", "1500"));
const MAX_S = Number(opt("max-s", "200"));
const profiles = connectorOptions((n, f) =>
  n === "source-profile" ? opt(n, "packages/sim/lab/before-after/market-profiles/direct.json") : opt(n, f),
).profiles;

interface Trace {
  seed: number;
  sources: number;
  firstPageS: number;
  allButFiveS: number;
  completeS: number;
  capS: number;
  calls: number;
  callsFirst10s: number;
  items: number;
  failed: number;
}

async function one(seed: number): Promise<Trace> {
  const world = buildWorld({ seed: seed * 1_000 });
  const sources = [...simSources(world, profiles, 1, seed), ...(NOISE ? noiseSources(world, NOISE, 20, 1, seed) : [])];
  const t0 = performance.now();
  const s = () => (performance.now() - t0) / 1_000;
  const cache = new ItemCache();
  const partner = new ContextPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(":memory:", { seed }),
    cache,
    budget: new Budget(),
    model: null,
    planner: new QueryPlanner({ seed }),
    now: () => world.now + (performance.now() - t0),
    config: { syncKick: true, syncKickLanes: LANES, syncKickRetryMs: RETRY_MS },
  });
  const scope = { tenantId: "t", userId: `u${seed}` };
  const sync = partner.sync as unknown as {
    users: Map<string, { sources: Map<string, { phase: string; cursor?: string; failures: number }> }>;
    stats: { backgroundCalls: number };
    warm(scope: unknown): boolean;
  };
  await partner.observe({ ...scope, sessionId: "connect", at: world.now, kind: "session_start" } as AgentEvent);
  const out: Trace = {
    seed,
    sources: sources.length,
    firstPageS: -1,
    allButFiveS: -1,
    completeS: -1,
    capS: -1,
    calls: 0,
    callsFirst10s: -1,
    items: 0,
    failed: 0,
  };
  const cap = partner.config.syncMaxItems;
  let failedEver = 0;
  while (s() < MAX_S) {
    await Bun.sleep(100);
    const state = [...([...sync.users.values()][0]?.sources.values() ?? [])];
    const read = state.filter((x) => x.phase === "warm" || x.cursor !== undefined).length;
    const warm = state.filter((x) => x.phase === "warm").length;
    failedEver = Math.max(failedEver, state.filter((x) => x.failures > 0).length);
    const held = cache.syncedCount(scope);
    const all = state.length === sources.length;
    if (out.firstPageS < 0 && all && read === sources.length) out.firstPageS = s();
    if (out.allButFiveS < 0 && all && warm >= sources.length - 5) out.allButFiveS = s();
    if (out.capS < 0 && held >= Math.min(cap, 1)) if (held >= cap) out.capS = s();
    if (out.callsFirst10s < 0 && s() >= 10) out.callsFirst10s = sync.stats.backgroundCalls;
    if (all && warm === sources.length) {
      out.completeS = s();
      break;
    }
  }
  out.calls = sync.stats.backgroundCalls;
  out.items = cache.syncedCount(scope);
  out.failed = failedEver;
  partner.stopSync();
  return out;
}

const f = (x: number) => (x < 0 ? "    -" : x.toFixed(1).padStart(5));
console.log(
  `one new user alone, ${NOISE + 5} sources, syncKick with ${LANES ? `a pool of ${LANES}` : "batches of 8"}, ` +
    `first retry ${RETRY_MS} ms; seconds since the first event`,
);
console.log(
  "  seed | every source's first page | all but 5 complete | all complete | at the cap | calls (in 10 s) | items | sources that failed at once, most",
);
const rows: Trace[] = [];
for (let k = 0; k < USERS; k++) {
  const r = await one(41 + k);
  rows.push(r);
  console.log(
    `  ${String(r.seed).padStart(4)} | ${f(r.firstPageS)}                     | ${f(r.allButFiveS)}              | ` +
      `${f(r.completeS)}        | ${f(r.capS)}      | ${String(r.calls).padStart(5)} (${String(r.callsFirst10s).padStart(4)})   | ` +
      `${String(r.items).padStart(5)} | ${r.failed}`,
  );
}
console.log(JSON.stringify({ noise: NOISE, lanes: LANES, retryMs: RETRY_MS, rows }));
process.exit(0);
