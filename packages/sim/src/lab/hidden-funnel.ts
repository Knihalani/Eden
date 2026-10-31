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
 *     [--config '{"probes":true}'] [--json out.json] [--label probes] [--no-record] [--judge live [--model m]]
 *     [--sync] [--cards DIR/cards.jsonl]
 *
 * `--judge live` gives Eden its judge (OpenRouter, `OPENROUTER_API_KEY`): the funnel then measures what the judge lets
 * through, hidden and decoy, and its calls, tokens and spend (about $0.03 for the 456 held-out tasks), a cheap screen
 * before an agent run. Seeds run concurrently.
 *
 * `--cards FILE` gives Eden implication cards (`cards.ts`, docs/research/moon-cards.md) replayed from a disk cache made
 * by `cards-enrich.ts` (no model call here; an item with no cached card is uncovered). They are made as items enter the
 * cache, and used from the next request on; with `--sync`, for every item before the first request. Turn them on with
 * `"cards": true` in `--config`.
 *
 * `--suite` names any suite of `suites.ts`, or several: each gets its own table, then a TOTAL over all of them.
 * Each suite's run is recorded in the benchmark ledger (bench/, `ledger.ts`) unless `--no-record`.
 */
import { writeFileSync } from "node:fs";
import { CardEnricher, ContextPartner, ItemCache } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget, OpenRouterModel, type Model } from "@eden/llm";
import type { AgentEvent } from "@eden/protocol";
import { QueryPlanner } from "@eden/sources";
import { REALISTIC, simSources } from "../sources";
import { buildWorld } from "../world";
import { DiskCardMaker } from "./cards-disk";
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
const LIVE = opt("judge", "none") === "live";
const SYNC = args.includes("--sync");
const CARDS = opt("cards", "");
/** One replaying maker for every seed and suite: the disk cache is read once. */
const cardMaker = CARDS ? new DiskCardMaker(CARDS) : null;
/** No cap on replayed cards: they cost nothing here (the enrichment's spend is `cards-enrich.ts`'s). */
const UNCAPPED = { callsPerSession: Infinity, usdPerSession: Infinity, usdPerUserDay: Infinity };
const KEY = process.env.OPENROUTER_API_KEY;
if (LIVE && !KEY) throw new Error("--judge live needs OPENROUTER_API_KEY");
const MODEL = opt("model", "z-ai/glm-5.3-flash");
/** The live judge's use over the whole run (every suite): calls, tokens and OpenRouter's reported cost. */
const usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
const metered = (inner: Model): Model => ({
  id: inner.id,
  chat: async (request) => {
    const res = await inner.chat(request);
    usage.calls++;
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    usage.costUsd += res.costUsd;
    return res;
  },
});

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
    const results = await Promise.all(SEEDS.map((seed) => runSeed(suite, variant, seed)));
    for (const r of results) {
      for (const t of r) {
        const both = rows.get(t.template) ?? { hidden: row(), control: row() };
        rows.set(t.template, both);
        const x = both[variant];
        x.n++;
        if (t.returned) x.returned++;
        if (t.cached) x.cached++;
        if (t.delivered) x.delivered++;
        x.calls += t.calls;
        x.ms += t.ms;
        perTask.push({ ...t });
      }
    }
  }
  return { rows, perTask, wall: (performance.now() - started) / 1000 };
}

interface TaskRow {
  seed: number;
  variant: "hidden" | "control";
  template: string;
  returned: boolean;
  cached: boolean;
  delivered: boolean;
  why: string;
  injected: number;
  calls: number;
  ms: number;
}

/** One suite's tasks in one seed's world, in order, as one user would bring them. */
async function runSeed(suite: string, variant: "hidden" | "control", seed: number): Promise<TaskRow[]> {
  const perTask: TaskRow[] = [];
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
  const cards = cardMaker
    ? new CardEnricher({ maker: cardMaker, budget: new Budget(UNCAPPED), now: () => clock })
    : null;
  const partner = new ContextPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(":memory:", { seed }),
    cache,
    budget: new Budget(),
    model: LIVE ? metered(new OpenRouterModel({ apiKey: KEY!, model: MODEL })) : null,
    planner: new QueryPlanner({ seed }),
    now: () => clock,
    config: CONFIG,
    onTrace: (t) => (calls += t.sourceCalls),
    ...(cards ? { cards } : {}),
  });
  const scope = { tenantId: "funnel", userId: `w${seed}` };
  // `--sync`: the experiment where Eden has already synced every item of the user's sources into its own index.
  if (SYNC) {
    const synced = cache.put(
      scope,
      sources.flatMap((s) => s.listAll()),
      clock,
    );
    // A sync's items are enriched as a sync would enrich them, before the first request.
    if (cards) {
      cards.enqueue(scope, synced);
      await cards.idle();
    }
  }
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
      // A live judge answers in seconds: the slow path is waited for, so what it lets through counts here.
      { waitMs: LIVE ? 30_000 : 3_000 },
    );
    const ms = performance.now() - t0;
    const injections = [...(r.injection ? [r.injection] : []), ...partner.takePending({ ...scope, sessionId })];
    // Enrichment of what this request brought in finishes before the next request (it lands one request later).
    if (cards) await cards.idle();
    const got = injections.flatMap((x) => x.citations.map((c) => c.itemId));
    // How the planted item was delivered (the injection reason's kind: sources, grounded-…, fallback, model).
    const why = injections.find((x) => x.citations.some((c) => c.itemId === id))?.reason.split(":")[0] ?? "";
    perTask.push({
      seed,
      variant,
      template: task.template,
      returned: returned.has(id),
      cached: !!cache.get(scope, id, clock),
      delivered: got.includes(id),
      why,
      injected: got.length,
      calls: calls - callsBefore,
      ms: Number(ms.toFixed(2)),
    });
  }
  return perTask;
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
if (cardMaker) console.log(`cards: ${cardMaker.hits} replayed, ${cardMaker.misses} uncovered (no cached card)`);
if (LIVE) {
  const tasks = Math.max(1, grand.hidden.n + grand.control.n);
  console.log(
    `judge ${MODEL}: ${usage.calls} calls (${(usage.calls / tasks).toFixed(2)}/task), ` +
      `${(usage.inputTokens / Math.max(1, usage.calls)).toFixed(0)} in / ` +
      `${(usage.outputTokens / Math.max(1, usage.calls)).toFixed(0)} out tokens per call, ` +
      `$${usage.costUsd.toFixed(4)} ($${((1000 * usage.costUsd) / tasks).toFixed(4)} per 1k tasks)`,
  );
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
      ...(LIVE && suite === runs[0]!.suite
        ? {
            judgeCallsPerTask: usage.calls / Math.max(1, grand.hidden.n + grand.control.n),
            judgeInputTokens: usage.inputTokens / Math.max(1, usage.calls),
            judgeOutputTokens: usage.outputTokens / Math.max(1, usage.calls),
            judgeUsdPer1kTasks: (1000 * usage.costUsd) / Math.max(1, grand.hidden.n + grand.control.n),
          }
        : {}),
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
        // The judge's spend is the whole run's (all suites), booked on the first suite's record.
        costUsd: suite === runs[0]!.suite ? Number(usage.costUsd.toFixed(6)) : 0,
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
        // Per task, with the suite: how each planted item was delivered (`why`), for breakdowns by path.
        perTask: runs.flatMap((r) => r.perTask.map((t) => ({ suite: r.suite, ...t }))),
      },
      null,
      2,
    ),
  );
}
