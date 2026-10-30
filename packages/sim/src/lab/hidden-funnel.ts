#!/usr/bin/env bun
/**
 * The free tier of the hidden-context benchmark (docs/research/probes.md): each task's request is played through
 * Eden alone, with no agent and no model, and the planted item is followed through the engine's funnel. Deterministic
 * and offline, so any change to retrieval or delivery can be checked in seconds before a live run.
 *
 * For each template, and in total:
 * - hidden tasks: was the planted item returned by a source, cached, delivered (higher is better);
 * - control tasks (the decoy planted instead): was the decoy delivered (noise: lower is better);
 * - source calls per task, and the engine's wall time per task.
 *
 *   bun packages/sim/src/lab/hidden-funnel.ts [--suite hidden|heldout|heldout-all|all|a,b] [--seeds 41,42,43,44]
 *     [--config '{"probes":true}'] [--json out.json] [--label probes] [--no-record]
 *
 * `--suite` names any suite of `suites.ts`, or several: each gets its own table, then a TOTAL over all of them.
 * Each suite's run is recorded in the benchmark ledger (bench/, `ledger.ts`) unless `--no-record`.
 */
import { writeFileSync } from "node:fs";
import { ContextPartner, ItemCache } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent } from "@eden/protocol";
import { QueryPlanner } from "@eden/sources";
import { REALISTIC, simSources } from "../sources";
import { buildWorld } from "../world";
import { clearSlot, dress } from "./hidden-context";
import { record, tidy } from "./ledger";
import { parseSuites, SUITES, type HiddenTask } from "./suites";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const SUITE = opt("suite", "hidden");
const SUITE_LIST = parseSuites(SUITE);
const SEEDS = opt("seeds", "41,42,43,44").split(",").map(Number);
const CONFIG = JSON.parse(opt("config", "{}")) as Record<string, unknown>;

interface Row {
  n: number;
  returned: number;
  cached: number;
  delivered: number;
  calls: number;
  ms: number;
}
type Rows = Map<string, { hidden: Row; control: Row }>;
const row = (): Row => ({ n: 0, returned: 0, cached: 0, delivered: 0, calls: 0, ms: 0 });

/** One suite through the funnel: per-template rows and one record per task. Each suite plants its own worlds. */
async function runSuite(suite: string): Promise<{ rows: Rows; perTask: Record<string, unknown>[]; wall: number }> {
  const rows: Rows = new Map();
  const perTask: Record<string, unknown>[] = [];
  const started = performance.now();
  for (const variant of ["hidden", "control"] as const) {
    for (const seed of SEEDS) {
      const world = buildWorld({ seed: seed * 1_000 });
      const before = world.items.length;
      const tasks: HiddenTask[] = SUITES[suite]!(world, seed, variant);
      const planted = world.items.slice(before);
      for (const it of planted) dress(world, it);
      // The slot each request asks for is otherwise free, so a clash is the planted one (clearSlot).
      const keep = new Set(planted.map((it) => it.id));
      for (const task of tasks) clearSlot(world, task.text, keep);
      const sources = simSources(world, REALISTIC, 0, seed);
      const returned = new Set<string>();
      for (const s of sources) {
        const search = s.search.bind(s);
        s.search = async (q, signal) => {
          const items = await search(q, signal);
          for (const i of items) returned.add(i.id);
          return items;
        };
      }
      let clock = world.now;
      const cache = new ItemCache();
      let calls = 0;
      const partner = new ContextPartner({
        sources: async () => sources,
        sourceMap: new SourceMap(":memory:", { seed }),
        cache,
        budget: new Budget(),
        model: null,
        planner: new QueryPlanner({ seed }),
        now: () => clock,
        config: CONFIG,
        onTrace: (t) => (calls += t.sourceCalls),
      });
      const scope = { tenantId: "funnel", userId: `w${seed}` };
      for (const [i, task] of tasks.entries()) {
        clock += 3_600_000;
        const id = planted[i]!.id;
        const sessionId = task.id;
        returned.clear();
        const callsBefore = calls;
        const t0 = performance.now();
        const at = clock;
        await partner.observe({ ...scope, sessionId, at, kind: "session_start" } as AgentEvent);
        const r = await partner.observe(
          { ...scope, sessionId, at, kind: "user_message", text: task.text } as AgentEvent,
          {
            waitMs: 3_000,
          },
        );
        const ms = performance.now() - t0;
        const got = [...(r.injection ? [r.injection] : []), ...partner.takePending({ ...scope, sessionId })].flatMap(
          (x) => x.citations.map((c) => c.itemId),
        );
        const both = rows.get(task.template) ?? { hidden: row(), control: row() };
        rows.set(task.template, both);
        const x = both[variant];
        x.n++;
        if (returned.has(id)) x.returned++;
        if (cache.get(scope, id, clock)) x.cached++;
        if (got.includes(id)) x.delivered++;
        x.calls += calls - callsBefore;
        x.ms += ms;
        perTask.push({
          seed,
          variant,
          template: task.template,
          returned: returned.has(id),
          cached: !!cache.get(scope, id, clock),
          delivered: got.includes(id),
          injected: got.length,
          calls: calls - callsBefore,
          ms: Number(ms.toFixed(2)),
        });
      }
    }
  }
  return { rows, perTask, wall: (performance.now() - started) / 1000 };
}

const pct = (a: number, n: number) => `${a}/${n}`;
const line = (name: string, r: { hidden: Row; control: Row }) =>
  `${name.padEnd(24)} ${pct(r.hidden.returned, r.hidden.n).padStart(16)} ${pct(r.hidden.delivered, r.hidden.n).padStart(9)}` +
  `   ${pct(r.control.delivered, r.control.n).padStart(22)}` +
  `   ${(r.hidden.calls / Math.max(1, r.hidden.n)).toFixed(1).padStart(10)}` +
  ` ${(r.hidden.ms / Math.max(1, r.hidden.n)).toFixed(1).padStart(8)}`;
const add = (into: { hidden: Row; control: Row }, r: { hidden: Row; control: Row }) => {
  for (const v of ["hidden", "control"] as const) {
    for (const k of Object.keys(into[v]) as (keyof Row)[]) into[v][k] += r[v][k];
  }
};

console.log(`suite ${SUITE_LIST.join(",")}, seeds ${SEEDS.join(",")}, config ${JSON.stringify(CONFIG)}`);
const header = "template                 hidden: returned delivered   control: decoy delivered   calls/task  ms/task";
const grand = { hidden: row(), control: row() };
const runs: { suite: string; rows: Rows; perTask: Record<string, unknown>[]; wall: number; total: typeof grand }[] = [];
for (const suite of SUITE_LIST) {
  const { rows, perTask, wall } = await runSuite(suite);
  const total = { hidden: row(), control: row() };
  if (SUITE_LIST.length > 1) console.log(`\n== ${suite}`);
  console.log(header);
  for (const [name, r] of rows) {
    add(total, r);
    console.log(line(name, r));
  }
  console.log(line(SUITE_LIST.length > 1 ? `total ${suite}` : "TOTAL", total));
  add(grand, total);
  runs.push({ suite, rows, perTask, wall, total });
}
// Several suites: the TOTAL over all of them, as the last table line (bench.ts reads the line before `recorded`).
if (SUITE_LIST.length > 1) {
  console.log(`\n${header}`);
  for (const r of runs) console.log(line(r.suite, r.total));
  console.log(line("TOTAL", grand));
}
if (!args.includes("--no-record")) {
  for (const { suite, rows, perTask, wall, total: t } of runs) {
    const n = (k: keyof Row, v: "hidden" | "control") => t[v][k] / Math.max(1, t[v].n);
    const metrics: Record<string, number> = {
      hiddenReturned: n("returned", "hidden"),
      hiddenCached: n("cached", "hidden"),
      hiddenDelivered: n("delivered", "hidden"),
      decoyDelivered: n("delivered", "control"),
      callsPerTask: (t.hidden.calls + t.control.calls) / Math.max(1, t.hidden.n + t.control.n),
      msPerTask: (t.hidden.ms + t.control.ms) / Math.max(1, t.hidden.n + t.control.n),
      tasks: t.hidden.n + t.control.n,
    };
    for (const [name, r] of rows) {
      metrics[`delivered.${name}`] = r.hidden.delivered / Math.max(1, r.hidden.n);
      metrics[`decoy.${name}`] = r.control.delivered / Math.max(1, r.control.n);
    }
    const e = record(
      {
        tier: "funnel",
        suite,
        label: opt("label", Object.keys(CONFIG).length ? "custom" : "baseline"),
        config: CONFIG,
        seeds: SEEDS,
        costUsd: 0,
        wallSeconds: Number(wall.toFixed(1)),
        metrics: tidy(metrics),
      },
      perTask,
    );
    console.log(`recorded ${e.id}`);
  }
}
const out = opt("json", "");
if (out) {
  // One suite keeps the original shape; several add `suites`, and `rows`/`total` are over all of them.
  const rows = Object.fromEntries(
    runs.flatMap((r) => [...r.rows].map(([k, v]) => [SUITE_LIST.length > 1 ? `${r.suite}/${k}` : k, v])),
  );
  const suites = Object.fromEntries(runs.map((r) => [r.suite, { rows: Object.fromEntries(r.rows), total: r.total }]));
  writeFileSync(
    out,
    JSON.stringify(
      {
        suite: SUITE_LIST.join(","),
        seeds: SEEDS,
        config: CONFIG,
        rows,
        total: grand,
        ...(SUITE_LIST.length > 1 ? { suites } : {}),
      },
      null,
      2,
    ),
  );
}
