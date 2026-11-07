/**
 * A7 (D291): Eden's connector calls outside the tasks of the no-key Pi run, at $0. pi-ab's timelines count only the
 * calls made during a task (none in `a7-nokey-*`: every lookup answered from the synced index, and `--push payload`
 * notices carry their items); the backfill before a stream's first task and the sync tick between tasks run with no
 * task current, so they are not in any timeline. This replays exactly that part of pi-ab's stream (`runStream`): the
 * same world per suite, variant and seed (`worldOf`), the same sources and profile, the same partner settings
 * (`DEFAULT_CONFIG`, no model: the sync needs none, so `eden` and `eden+nokey` make the same calls), the backfill
 * loop, then one tick per task. Time scale 0 (counts, not latency).
 *
 *   bun packages/sim/lab/a7/connector-calls.ts > packages/sim/lab/a7/connector-calls.json
 */
import { ContextPartner, ItemCache } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { QueryPlanner, type Source } from "@eden/sources";
import { worldOf } from "../../src/lab/ab-common";
import { connectorOptions, pushNotifier, sourceFields } from "../../src/lab/connector-options";
import { simSources } from "../../src/sources";

const PROFILE = "packages/sim/lab/before-after/market-profiles/direct.json";
const LIMIT = 12;
const opts = connectorOptions((name, fallback) =>
  name === "source-profile" ? PROFILE : name === "push" ? "payload" : fallback,
);
const out: Record<string, { backfill: Record<string, number>; run: Record<string, number>; tasks: number }> = {};

for (const seed of [41, 42]) {
  for (const suite of ["train1", "train2", "train3", "train4", "train5", "train6"]) {
    for (const variant of ["hidden", "control", "neutral"] as const) {
      const { world, tasks } = worldOf(seed, suite, variant, { maxTasks: 30, maxOffworld: 5 });
      const n = Math.min(LIMIT, tasks.length);
      const sources = simSources(world, opts.profiles, 0, seed);
      const notify = pushNotifier(sources, opts, seed);
      let phase: "backfill" | "run" = "backfill";
      const calls = { backfill: {} as Record<string, number>, run: {} as Record<string, number> };
      const count = (op: string) => (calls[phase][op] = (calls[phase][op] ?? 0) + 1);
      const counted: Source[] = sources.map((s) => ({
        ...sourceFields(s),
        search: (q, sig) => (count("search"), s.search(q, sig)),
        fetch: (ref, scope, sig) => (count("fetch"), s.fetch(ref, scope, sig)),
        list: (scope, cursor, limit, sig) => (count("list"), s.list(scope, cursor, limit, sig)),
      }));
      let clock = world.now;
      const partner = new ContextPartner({
        sources: async () => counted,
        sourceMap: new SourceMap(":memory:", { seed }),
        cache: new ItemCache(),
        budget: new Budget(),
        model: null,
        planner: new QueryPlanner({ seed }),
        now: () => clock,
        config: {},
      });
      const scope = { tenantId: "ab", userId: `w${seed}` };
      const sync = partner.sync!;
      const start = clock;
      clock -= 30 * 60_000;
      sync.track(scope, clock);
      for (let i = 0; i < 120 && !sync.warm(scope); i++) {
        await sync.tick();
        clock += 60_000;
      }
      clock = start;
      phase = "run";
      for (let t = 0; t < n; t++) {
        clock += 3_600_000;
        await sync.tick();
        notify(partner, scope);
      }
      partner.stopSync();
      out[`${seed}:${suite}:${variant}`] = { ...calls, tasks: n };
    }
  }
}
const sum = (k: "backfill" | "run") =>
  Object.values(out).reduce((a, x) => a + Object.values(x[k]).reduce((p, q) => p + q, 0), 0);
const tasks = Object.values(out).reduce((a, x) => a + x.tasks, 0);
console.log(
  JSON.stringify(
    { streams: Object.keys(out).length, tasks, backfillCalls: sum("backfill"), runCalls: sum("run"), byStream: out },
    null,
    1,
  ),
);
process.exit(0);
