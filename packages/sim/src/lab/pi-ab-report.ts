#!/usr/bin/env bun
/**
 * The report of a `pi-ab.ts` run: its results file with the timelines beside it (`<timeline>/tasks.jsonl` and
 * `samples.jsonl`). `agent-ab-report.ts` reads the same results file for the tables the two harnesses share.
 *
 *   bun packages/sim/src/lab/pi-ab-report.ts pi-ab.json [more.json ...] [--timeline dir] [--seconds 20]
 *
 * Per condition and task kind: the hidden-fact rate (hidden tasks) or false-concern rate (control tasks), cost per
 * 1k tasks with Eden's model cost broken out, model and tool calls per task, tokens in and out, end-to-end p50, p90
 * and p99, and time to first token. Then the critical path (each instant of a task's wall time given to Eden's
 * blocking work, a model request, a tool call or the loop itself), Eden's background work, paired bootstrap
 * differences between conditions, the per-second profile of task time, Eden's internals, and the process's CPU and
 * memory samples. Several files are pooled (a task run under the same condition twice: the later file's).
 *
 * Also, from the timelines: the agent's cost re-priced at fixed endpoint prices beside the billed cost, with the
 * endpoint mix each condition was routed to (`reprice.ts`: routing moves billed cost between conditions), and uptake
 * on hidden tasks: how often the fact was raised when Eden's packet cited the planted item, when only an
 * `ask_context` answer did, and when neither did. A variant or flag condition (`eden~ALL2`, `eden+askDedup`) is
 * paired with the condition it modifies.
 *
 * Each paired cost difference also reads cache-neutral (D171): the agent's tokens repriced at the model's list price
 * with cached and cache-write tokens billed as plain input, plus Eden's own cost, beside the billed difference. pi-ab
 * runs the conditions concurrently with one system prompt, so the arm that writes the prompt cache first makes the
 * other cheaper; D112's "no extra paid cost" reads the cache-neutral sum, and billed stays printed so a variant that
 * really breaks within-task caching stays visible. Per pair, all kinds pooled and the pairs whose asks were identical
 * (where nothing but the cache race can move the agent's cost) get a line of their own.
 *
 * After the outcome tables, a traffic-weighted row per condition for w in {0.1, 0.5}: w × hidden + (1 − w) × control
 * (pi-ab-weighted.ts; most traffic is silent, so hidden-only cost understates). `--weighted report.txt` prints the
 * weighted means of a report kept only as text.
 */
import { existsSync, readFileSync } from "node:fs";
import { Rng } from "../rng";
import { backfillShares, type Background, type RunResult, type Task } from "./ab-common";
import { TRAFFIC_WEIGHTS, weightedFromReport, weightedLines, weightedRow, type WeightedRow } from "./pi-ab-weighted";
import { pairedWith } from "./pi-conditions";
import {
  cacheNeutral,
  endpointMix,
  ENDPOINT_PRICES,
  FIXED_PRICES,
  MODEL_PRICES,
  repricedUsd,
  type Price,
} from "./reprice";
import { uptakeWay } from "./uptake";
import {
  bootstrap,
  breakdown,
  CATEGORIES,
  covered,
  perSecond,
  quantile,
  spansOf,
  type Category,
  type Span,
  type TimelineEvent,
} from "./pi-timeline";

interface RunFile {
  model: string;
  grader: string;
  spent: number;
  spend?: { agent: number; eden: number; grader: number };
  /** Per stream, Eden's spend no task is charged for (cards, bridge); absent before 2026-11-03. */
  background?: Background[];
  harness?: string;
  config?: Record<string, unknown>;
  timeScale?: number;
  toolExecution?: string;
  timeline?: string;
  wallSeconds?: number;
  tasks: Task[];
  results: RunResult[];
}
interface Record_ {
  task: string;
  condition: string;
  kind: Task["kind"];
  wallMs: number;
  firstTokenMs: number | null;
  requests: {
    startMs: number;
    firstTokenMs: number | null;
    endMs: number;
    in: number;
    out: number;
    cost: number;
    cached?: number;
    cacheWrite?: number;
  }[];
  events: TimelineEvent[];
  planted?: string;
  cited?: string[];
  askCited?: string[];
  /** The agent's ask_context calls (question, cited items); absent on a task that asked nothing. */
  asks?: unknown[];
}
interface Sample {
  t: number;
  cpuPct: number;
  userMs: number;
  systemMs: number;
  rssMb: number;
  heapMb: number;
  tasks: number;
  requests: number;
}

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (flag("reconcile")) {
  // Exits 1 when the columns do not add up to the header's Eden total within $0.01, so a script can gate on it.
  process.exit(reconcile(flag("reconcile")!, flag("ledger") ?? "", flag("run") ?? "") ? 0 : 1);
}
if (flag("weighted")) {
  // `--weighted report.txt`: the traffic-weighted means of a report kept only as text (no per-task samples, so no
  // percentiles): the Haiku campaign's frontier (docs/research/haiku-phase3.md) was recomputed with it at $0.
  for (const line of weightedLines(weightedFromReport(readFileSync(flag("weighted")!, "utf8")))) console.log(line);
  process.exit(0);
}
const files = argv.filter((a, i) => a.endsWith(".json") && !argv[i - 1]?.startsWith("--"));
if (!files.length) throw new Error("usage: pi-ab-report.ts pi-ab.json [more.json ...] [--timeline dir]");
const SECONDS = Number(flag("seconds") ?? "20");
const runs = files.map((f) => JSON.parse(readFileSync(f, "utf8")) as RunFile);
const tasks = new Map(runs.flatMap((r) => r.tasks).map((t) => [t.id, t]));
const key = (task: string, condition: string) => `${task}\u0000${condition}`;
const results = [...new Map(runs.flatMap((r) => r.results).map((r) => [key(r.task, r.condition), r])).values()];
const records = new Map<string, Record_>();
const samples: Sample[] = [];
for (const [i, run] of runs.entries()) {
  const dir = flag("timeline") ?? run.timeline ?? files[i]!.replace(/\.json$/, ".timeline");
  if (existsSync(`${dir}/tasks.jsonl`)) {
    for (const line of readFileSync(`${dir}/tasks.jsonl`, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line) as Record_;
      records.set(key(rec.task, rec.condition), rec);
    }
  } else console.log(`(no timeline at ${dir}: timing sections cover what the results file holds)`);
  if (existsSync(`${dir}/samples.jsonl`)) {
    for (const line of readFileSync(`${dir}/samples.jsonl`, "utf8").split("\n"))
      if (line.trim()) samples.push(JSON.parse(line) as Sample);
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const f = (x: number, d = 3) => x.toFixed(d);
const sign = (x: number, d = 3) => (x >= 0 ? "+" : "") + x.toFixed(d);
const conditions = [...new Set(results.map((r) => r.condition))];
const ok = results.filter((r) => !r.error && tasks.has(r.task));
const recall = (r: RunResult) => {
  const must = tasks.get(r.task)!.must;
  return must.filter((m) => r.facts?.[m.id]).length / Math.max(1, must.length);
};
const join = (xs: (string | undefined)[]) => [...new Set(xs.filter(Boolean))].join(",");
const spend = runs.reduce(
  (s, r) => ({
    agent: s.agent + (r.spend?.agent ?? 0),
    eden: s.eden + (r.spend?.eden ?? 0),
    grader: s.grader + (r.spend?.grader ?? 0),
  }),
  { agent: 0, eden: 0, grader: 0 },
);
console.log(
  `harness ${join(runs.map((r) => r.harness ?? "in-house"))}, model ${join(runs.map((r) => r.model))}, grader ` +
    `${join(runs.map((r) => r.grader))}, time scale ${join(runs.map((r) => String(r.timeScale ?? 0)))}, tools ` +
    `${join(runs.map((r) => r.toolExecution ?? "sequential"))}`,
);
console.log(
  `spent $${f(
    runs.reduce((n, r) => n + r.spent, 0),
    4,
  )} (agent $${f(spend.agent, 4)}, Eden $${f(spend.eden, 4)}, grader $${f(spend.grader, 4)}); ` +
    `${results.length} runs, errors ${results.length - ok.length}, ungraded ` +
    `${ok.filter((r) => !r.facts && tasks.get(r.task)!.must.length).length}`,
);
console.log(`config ${join(runs.map((r) => JSON.stringify(r.config ?? {})))}`);

// ---- Eden's spend no task is charged for (cards, bridge), shared out over the task runs (ab-common.ts states how).
const hasBackground = runs.every((r) => r.background !== undefined);
const shares = backfillShares(runs.flatMap((r) => r.background ?? []));
const backfill = (r: RunResult) => shares.get(key(r.task, r.condition)) ?? 0;
console.log(
  "cost columns, $ per 1k tasks: $/1k = agent + Eden's per-task calls; (Eden) = Eden's per-task calls (its reader and " +
    "judge); bkfill = its background calls (cards, bridge), each seed's spread evenly over that seed's task runs " +
    "with cards or bridge on (mostly a one-time backfill: an upper bound on the steady state); all-in = (Eden) + " +
    "bkfill" +
    (hasBackground ? "" : ". bkfill and all-in: '-', a results file from before they were recorded"),
);

// ---- Outcomes and cost, per condition and task kind.
const KINDS = ["hidden", "control", "request", "arrival", "offworld"] as const;
const what: Record<string, string> = {
  hidden: "hidden fact raised",
  control: "false concern",
  request: "fact recall",
  arrival: "fact recall",
  offworld: "",
};
for (const kind of KINDS) {
  const rows = conditions
    .map((c) => ({ c, rs: ok.filter((r) => r.condition === c && tasks.get(r.task)!.kind === kind) }))
    .filter((x) => x.rs.length);
  if (!rows.length) continue;
  console.log(`\n== ${kind}${what[kind] ? `: ${what[kind]}` : ""}`);
  console.log(
    "condition     n   rate   $/1k  (Eden) bkfill all-in  calls  tools   in tok  out tok   p50 s   p90 s   p99 s" +
      "  ttft p50 ms",
  );
  for (const { c, rs } of rows) {
    const graded = rs.filter((r) => r.facts);
    const wall = rs.map((r) => r.wallMs / 1_000);
    const ttft = rs
      .map((r) => records.get(key(r.task, r.condition))?.firstTokenMs)
      .filter((x): x is number => x != null);
    const m = (pick: (r: RunResult) => number, digits: number, width: number) =>
      f(mean(rs.map(pick)), digits).padStart(width);
    const q = (p: number) => f(quantile(wall, p), 2).padStart(7);
    const cells = [
      c.padEnd(12),
      String(rs.length).padStart(3),
      kind === "offworld" ? "    -" : ` ${f(mean(graded.map(recall)))}`,
      m((r) => 1_000 * (r.costUsd + r.edenCostUsd), 3, 6),
      m((r) => 1_000 * r.edenCostUsd, 3, 7),
      hasBackground ? m((r) => 1_000 * backfill(r), 3, 6) : "     -",
      hasBackground ? m((r) => 1_000 * (r.edenCostUsd + backfill(r)), 3, 6) : "     -",
      m((r) => r.modelCalls, 2, 6),
      m((r) => r.toolCalls, 2, 6),
      m((r) => r.promptTokens, 0, 8),
      m((r) => r.completionTokens, 0, 8),
      q(0.5),
      q(0.9),
      q(0.99),
      f(quantile(ttft, 0.5), 0).padStart(12),
    ];
    console.log(cells.join(" "));
  }
}

// ---- Traffic-weighted rows: a mix of hidden and control tasks (pi-ab-weighted.ts); p50/p90 from the pooled samples.
{
  const samplesOf = (c: string, kind: Task["kind"]) =>
    ok
      .filter((r) => r.condition === c && tasks.get(r.task)!.kind === kind)
      .map((r) => ({ usd: r.costUsd, edenUsd: r.edenCostUsd, tools: r.toolCalls, wallS: r.wallMs / 1_000 }));
  const rows = TRAFFIC_WEIGHTS.flatMap((w) =>
    conditions.map((c) => weightedRow(c, samplesOf(c, "hidden"), samplesOf(c, "control"), w)),
  ).filter((r): r is WeightedRow => r !== null);
  for (const line of weightedLines(rows)) console.log(line);
}

// ---- The critical path: where each task's wall time went.
const spansFor = new Map<string, Span[]>();
for (const [k, rec] of records) spansFor.set(k, spansOf(rec.events));
const edenBg = (spans: Span[]) => spans.filter((s) => s.lane === "bg" && s.cat === "eden");
const gradingOf = (spans: Span[]) => spans.filter((s) => s.cat === "grading");
console.log("\n== critical path, mean ms per task (share of wall time); Eden beside the loop and grading after it");
console.log(
  `condition     n   ${CATEGORIES.filter((c) => c !== "grading")
    .map((c) => c.padStart(14))
    .join("")}    eden-bg  grading`,
);
for (const c of conditions) {
  const recs = [...records.values()].filter((r) => r.condition === c);
  if (!recs.length) continue;
  const parts = recs.map((r) => breakdown(spansFor.get(key(r.task, r.condition))!, 0, r.wallMs));
  const wall = mean(recs.map((r) => r.wallMs));
  const cells = CATEGORIES.filter((x) => x !== "grading").map((cat) => {
    const m = mean(parts.map((p) => p[cat]));
    return `${f(m, 0)} (${f((100 * m) / Math.max(1, wall), 0)}%)`.padStart(14);
  });
  const bg = mean(recs.map((r) => covered(edenBg(spansFor.get(key(r.task, r.condition))!), 0, Infinity)));
  const grading = mean(recs.map((r) => covered(gradingOf(spansFor.get(key(r.task, r.condition))!), 0, Infinity)));
  console.log(
    `${c.padEnd(12)} ${String(recs.length).padStart(3)}   ${cells.join("")} ${f(bg, 0).padStart(10)} ${f(grading, 0).padStart(8)}`,
  );
}

// ---- Eden's share of the path split by task kind, by observe (the push) against the agent's asks, and by the reader
// inside both: the ceiling a change below the model can reach (D165). Eden's path spans outrank every other category
// in `breakdown`, so their union is exactly the eden column above; the reader is counted where it overlaps that union.
{
  type Iv = [number, number];
  const merged = (spans: Span[]): Iv[] => {
    const out: Iv[] = [];
    for (const s of [...spans].sort((a, b) => a.start - b.start)) {
      const last = out[out.length - 1];
      if (last && s.start <= last[1]) last[1] = Math.max(last[1], s.end);
      else out.push([s.start, s.end]);
    }
    return out;
  };
  const length = (xs: Iv[]) => xs.reduce((n, [a, b]) => n + (b - a), 0);
  const overlap = (xs: Iv[], ys: Iv[]) => {
    let n = 0;
    for (let i = 0, j = 0; i < xs.length && j < ys.length;) {
      n += Math.max(0, Math.min(xs[i]![1], ys[j]![1]) - Math.max(xs[i]![0], ys[j]![0]));
      if (xs[i]![1] < ys[j]![1]) i++;
      else j++;
    }
    return n;
  };
  const rows: string[] = [];
  for (const c of conditions)
    for (const kind of KINDS) {
      const recs = [...records.values()].filter((r) => r.condition === c && r.kind === kind);
      // Conditions with no Eden on the path (none, tools, both: Pi's both arm has no ask_context but does observe).
      if (!recs.some((r) => r.events.some((e) => e.cat === "eden" && e.lane === "path"))) continue;
      const parts = recs.map((r) => {
        // Clipped to the task's wall time, as `breakdown` is.
        const path = spansFor
          .get(key(r.task, r.condition))!
          .filter((s) => s.lane === "path" && s.cat === "eden" && s.start < r.wallMs)
          .map((s) => ({ ...s, end: Math.min(s.end, r.wallMs) }));
        const eden = merged(path);
        return {
          eden: length(eden),
          observe: length(merged(path.filter((s) => s.ev === "eden.observe"))),
          ask: length(merged(path.filter((s) => s.ev.startsWith("tool.")))),
          reader: overlap(eden, merged(path.filter((s) => s.ev === "eden.reader"))),
        };
      });
      const wall = mean(recs.map((r) => r.wallMs));
      const m = (pick: (p: (typeof parts)[number]) => number) => mean(parts.map(pick));
      const eden = m((p) => p.eden);
      rows.push(
        `${c.padEnd(12)} ${kind.padEnd(8)} ${String(recs.length).padStart(3)} ${f(wall, 0).padStart(7)} ` +
          `${`${f(eden, 0)} (${f((100 * eden) / Math.max(1, wall), 1)}%)`.padStart(14)} ` +
          `${f(
            m((p) => p.observe),
            0,
          ).padStart(8)} ${f(
            m((p) => p.ask),
            0,
          ).padStart(8)} ` +
          `${`${f(
            m((p) => p.reader),
            0,
          )} (${f((100 * m((p) => p.reader)) / Math.max(1, eden), 1)}%)`.padStart(15)} ` +
          `${f(wall / Math.max(1, wall - eden), 2).padStart(8)}x`,
      );
    }
  if (rows.length) {
    console.log(
      "\n== Eden on the critical path by task kind, mean ms per task: observe (the push) and ask_context, the " +
        "reader's share of Eden's path, and the wall-time multiple if Eden took no time",
    );
    console.log("condition    kind       n  wall ms   eden (% wall)  observe      ask  reader (% eden)  if-zero");
    for (const row of rows) console.log(row);
  }
  // Each reader call's latency against its output tokens (the span's `out`): the intercept is the floor no change
  // below the model removes. A fit of this run and endpoint, not a universal floor (reader-latency-fit.ts fits others).
  for (const c of conditions) {
    const calls = [...records.values()]
      .filter((r) => r.condition === c)
      .flatMap((r) => spansFor.get(key(r.task, r.condition))!.filter((s) => s.ev === "eden.reader"))
      .map((s) => ({ ms: s.end - s.start, out: Number(s.data?.out ?? NaN) }))
      .filter((x) => Number.isFinite(x.out));
    if (calls.length < 2) continue;
    const mx = mean(calls.map((x) => x.out));
    const my = mean(calls.map((x) => x.ms));
    const sxx = calls.reduce((n, x) => n + (x.out - mx) ** 2, 0);
    const slope = sxx ? calls.reduce((n, x) => n + (x.out - mx) * (x.ms - my), 0) / sxx : 0;
    const ms = calls.map((x) => x.ms);
    console.log(
      `${c.padEnd(12)} reader ${calls.length} calls: p50 ${f(quantile(ms, 0.5), 0)} p90 ${f(quantile(ms, 0.9), 0)}` +
        ` mean ${f(my, 0)} ms, mean out ${f(mx, 0)} tok; fit ${f(my - slope * mx, 0)} ms + ${f(slope, 2)} ms/out token` +
        ` (mean/floor ${f(my / Math.max(1, my - slope * mx), 2)}x)`,
    );
  }
}

// ---- Paired differences: the same task under two conditions, a bootstrap over tasks for the 95% interval.
const byTask = new Map<string, Map<string, RunResult>>();
for (const r of ok) {
  if (!byTask.has(r.task)) byTask.set(r.task, new Map());
  byTask.get(r.task)!.set(r.condition, r);
}
const rng = new Rng(1);
// D171's cache-neutral price: one model across the files, with a list price (reprice.ts); else no neutral cost.
const model = runs[0]?.model ?? "";
const listPrice = runs.every((r) => r.model === model) ? MODEL_PRICES[model] : undefined;
const neutralPrice = listPrice && records.size ? cacheNeutral(listPrice) : undefined;
const costRng = new Rng(2);
const PAIRS = [
  ["eden", "tools"],
  ["both", "tools"],
  ["eden", "none"],
  ["tools", "none"],
  ["both", "eden"],
  ["eden-judge", "eden"],
  ["both-judge", "both"],
  ["eden-judge", "tools"],
  ["both-judge", "tools"],
] as [string, string][];
// A wait, variant or flag condition ("both@w0", "eden~ALL2", "eden+askDedup") against the one it modifies.
for (const c of conditions) {
  const base = pairedWith(c);
  if (base && !PAIRS.some(([a, b]) => a === c && b === base)) PAIRS.push([c, base]);
}
console.log("\n== paired differences (a − b), bootstrap 95% interval over tasks");
for (const [a, b] of PAIRS) {
  for (const kind of ["hidden", "control", "request", "arrival"] as const) {
    const pairs = [...byTask.values()].filter((v) => v.has(a) && v.has(b) && tasks.get(v.get(a)!.task)!.kind === kind);
    const graded = pairs.filter((v) => v.get(a)!.facts && v.get(b)!.facts);
    if (!pairs.length) continue;
    const hit = bootstrap(
      graded.map((v) => recall(v.get(a)!) - recall(v.get(b)!)),
      () => rng.next(),
    );
    const wall = bootstrap(
      pairs.map((v) => (v.get(a)!.wallMs - v.get(b)!.wallMs) / 1_000),
      () => rng.next(),
    );
    const cost = bootstrap(
      pairs.map((v) => 1_000 * (v.get(a)!.costUsd + v.get(a)!.edenCostUsd - v.get(b)!.costUsd - v.get(b)!.edenCostUsd)),
      () => rng.next(),
    );
    console.log(
      `${a.padEnd(10)} - ${b.padEnd(6)} ${kind.padEnd(8)} n=${String(graded.length).padStart(3)}` +
        ` rate ${sign(hit.mean)} (${sign(hit.lo)}..${sign(hit.hi)})` +
        `  wall ${sign(wall.mean, 2)} s (${sign(wall.lo, 2)}..${sign(wall.hi, 2)})` +
        `  $/1k ${sign(cost.mean)} (${sign(cost.lo)}..${sign(cost.hi)})`,
    );
    const line = neutralCost(pairs, a, b, false);
    if (line) console.log(`${" ".repeat(22)}${line}`);
  }
  if (!neutralPrice) continue;
  // All kinds pooled, and the pairs that asked the same questions (both arms asked nothing, mostly): with the same
  // asks the arms send much the same requests, so a billed difference there is mostly the prompt-cache race.
  const all = [...byTask.values()].filter(
    (v) => v.has(a) && v.has(b) && tasks.get(v.get(a)!.task)!.kind !== "offworld",
  );
  const pooled = neutralCost(all, a, b, true);
  if (pooled) console.log(`${a.padEnd(10)} - ${b.padEnd(6)} all      ${pooled}`);
  // Only when the timelines record asks (pi-ab since 2026-11-05); an older file would read every pair as identical.
  if ([...records.values()].some((r) => r.asks !== undefined)) {
    const asks = (r: RunResult) => JSON.stringify(records.get(key(r.task, r.condition))?.asks ?? []);
    const same = neutralCost(
      all.filter((v) => asks(v.get(a)!) === asks(v.get(b)!)),
      a,
      b,
      true,
    );
    if (same) console.log(`${a.padEnd(10)} - ${b.padEnd(6)} same-ask ${same}`);
  }
}

/**
 * The paired cost line of D171, $ per 1k tasks: (billed agent+Eden,) cache-neutral agent+Eden (the D112 gate), the
 * agent billed and cache-neutral, and Eden's own per-task cost. Only pairs whose two runs both have a timeline record
 * (the agent's requests) count; null when none does or the model has no list price. Its own Rng, so the billed
 * intervals above are the same with or without it.
 */
function neutralCost(pairs: Map<string, RunResult>[], a: string, b: string, billedTotal: boolean): string | null {
  if (!neutralPrice) return null;
  const price = neutralPrice;
  const agentNeutral = (r: RunResult) => {
    const rec = records.get(key(r.task, r.condition));
    return rec ? repricedUsd(rec.requests, price) : null;
  };
  type Row = { a: RunResult; b: RunResult; na: number; nb: number };
  const rows = pairs
    .map((v) => ({ a: v.get(a)!, b: v.get(b)!, na: agentNeutral(v.get(a)!), nb: agentNeutral(v.get(b)!) }))
    .filter((x): x is Row => x.na !== null && x.nb !== null);
  if (!rows.length) return null;
  const ci = (pick: (x: Row) => number) => {
    const d = bootstrap(
      rows.map((x) => 1_000 * pick(x)),
      () => costRng.next(),
    );
    return `${sign(d.mean, 4)} (${sign(d.lo, 4)}..${sign(d.hi, 4)})`;
  };
  const eden = (x: Row) => x.a.edenCostUsd - x.b.edenCostUsd;
  const billed = (x: Row) => x.a.costUsd - x.b.costUsd;
  const neutral = (x: Row) => x.na - x.nb;
  return (
    `n=${String(rows.length).padStart(3)} $/1k` +
    (billedTotal ? ` billed agent+Eden ${ci((x) => billed(x) + eden(x))}` : "") +
    ` cache-neutral agent+Eden ${ci((x) => neutral(x) + eden(x))}` +
    `  agent billed ${ci(billed)} cache-neutral ${ci(neutral)}  Eden ${ci(eden)}`
  );
}

// ---- Per second of task time: the mean ms of each second spent in each phase, over the tasks still running then.
console.log(`\n== per-second profile: mean ms of each second of task time by phase, over tasks still running`);
for (const c of conditions) {
  const recs = [...records.values()].filter((r) => r.condition === c);
  if (!recs.length) continue;
  const prof = recs.map((r) => ({
    secs: perSecond(spansFor.get(key(r.task, r.condition))!, r.wallMs),
    bg: edenBg(spansFor.get(key(r.task, r.condition))!),
  }));
  const longest = Math.min(SECONDS, Math.max(...prof.map((p) => p.secs.length)));
  console.log(`-- ${c} (${recs.length} tasks)`);
  console.log(
    `   s  running ${CATEGORIES.filter((x) => x !== "grading")
      .map((x) => x.padStart(6))
      .join("")}  eden-bg`,
  );
  for (let s = 0; s < longest; s++) {
    const live = prof.filter((p) => p.secs.length > s);
    const cell = (cat: Category) => f(mean(live.map((p) => p.secs[s]![cat])), 0).padStart(6);
    const bg = mean(live.map((p) => covered(p.bg, s * 1_000, (s + 1) * 1_000)));
    console.log(
      `${String(s).padStart(4)}  ${f((100 * live.length) / recs.length, 0).padStart(5)}% ` +
        `${CATEGORIES.filter((x) => x !== "grading")
          .map(cell)
          .join("")} ${f(bg, 0).padStart(8)}`,
    );
  }
}

// ---- Agent cost re-priced at fixed endpoint prices (econ-research R3): routing moves billed cost between conditions.
// A model billed at one price (Anthropic direct) has no endpoint mix: its list price (which should match billed) and
// the cache-neutral price (D171) are the columns.
if ((ENDPOINT_PRICES[model] || MODEL_PRICES[model]) && records.size) {
  const prices: Record<string, Price> = ENDPOINT_PRICES[model] ? { ...FIXED_PRICES } : { list: MODEL_PRICES[model]! };
  if (MODEL_PRICES[model]) prices["neutral"] = cacheNeutral(MODEL_PRICES[model]!);
  const fixed = Object.keys(prices);
  console.log(
    `\n== agent $/1k tasks: billed, and re-priced at fixed ${model} prices (neutral: cached and cache-write tokens ` +
      `as plain input)${ENDPOINT_PRICES[model] ? "; endpoint mix (top 3)" : ""}`,
  );
  // A timeline from before pi-ab recorded cached tokens prices every token as uncached (reprice.ts): say so.
  const uncached = [...records.values()].every((r) => r.requests.every((q) => q.cached === undefined));
  if (uncached)
    console.log("(no cached-token counts recorded: cache hits are unmatched, re-priced cost is an upper bound)");
  console.log(`condition       n   billed ${fixed.map((x) => x.padStart(10)).join("")}  mix`);
  for (const c of conditions) {
    const recs = [...records.values()].filter((r) => r.condition === c);
    if (!recs.length) continue;
    const reqs = recs.flatMap((r) => r.requests);
    const per1k = (usd: number) => f((1_000 * usd) / recs.length).padStart(10);
    const mix = (ENDPOINT_PRICES[model] ? endpointMix(model, reqs) : [])
      .slice(0, 3)
      .map(([e, share]) => `${e} ${f(share, 2)}`)
      .join(", ");
    console.log(
      `${c.padEnd(12)} ${String(recs.length).padStart(4)} ${per1k(reqs.reduce((n, q) => n + q.cost, 0)).slice(1)}` +
        `${fixed.map((x) => per1k(repricedUsd(reqs, prices[x]!))).join("")}${mix ? `  ${mix}` : ""}`,
    );
  }
}

// ---- Uptake on hidden tasks: was the fact raised when the planted item reached the agent, and by which way.
const uptakeRows = conditions
  .map((c) => ({
    c,
    rs: ok.filter((r) => r.condition === c && r.facts && tasks.get(r.task)!.kind === "hidden"),
  }))
  .filter((x) => x.rs.some((r) => records.get(key(r.task, r.condition))?.planted));
if (uptakeRows.length) {
  console.log(
    "\n== uptake (hidden): raised rate (n) when the planted item was in a packet, only in an ask answer, or neither",
  );
  for (const { c, rs } of uptakeRows) {
    const way = (r: RunResult) => uptakeWay(records.get(key(r.task, r.condition)) ?? {});
    const cells = (["packet", "ask", "neither"] as const).map((w) => {
      const xs = rs.filter((r) => way(r) === w);
      return `${w} ${xs.length ? f(mean(xs.map(recall))) : "  -  "} (${xs.length})`;
    });
    console.log(`${c.padEnd(12)} ${cells.join("   ")}`);
  }
}

// ---- Eden's own work per task: its source calls, probe queries, cache hits, judge calls and slow path.
const edenConds = conditions.filter((c) => !/^(none|tools)(-act)?([~+@]|$)/.test(c));
if (edenConds.length) {
  console.log("\n== Eden per task: source calls, probe queries (calls), cache hits, judge calls, slow path and ask ms");
  for (const c of edenConds) {
    const recs = [...records.values()].filter((r) => r.condition === c);
    if (!recs.length) continue;
    const count = (r: Record_, ev: string) => r.events.filter((e) => e.ph === "B" && e.ev === ev).length;
    const starts = (r: Record_, prefix: string) =>
      r.events.filter((e) => e.ph === "B" && e.ev.startsWith(prefix)).length;
    const probeCalls = (r: Record_) =>
      r.events
        .filter((e) => e.ph === "B" && e.ev.startsWith("eden.probe:"))
        .reduce((n, e) => n + Number(e.data?.calls ?? 0), 0);
    const dur = (name: string) =>
      recs.flatMap((r) =>
        spansFor
          .get(key(r.task, r.condition))!
          .filter((s) => s.ev === name)
          .map((s) => s.end - s.start),
      );
    console.log(
      `${c.padEnd(12)} sources ${f(mean(recs.map((r) => count(r, "eden.source"))), 2)}` +
        `  probes ${f(mean(recs.map((r) => starts(r, "eden.probe:"))), 2)} (${f(mean(recs.map(probeCalls)), 2)} calls)` +
        `  cache hits ${f(mean(recs.map((r) => r.events.filter((e) => e.ev === "eden.cache-hit").length)), 2)}` +
        `  judge ${f(mean(recs.map((r) => count(r, "eden.judge"))), 2)}` +
        ` (p50 ${f(quantile(dur("eden.judge"), 0.5), 0)} ms)` +
        `  injected ${f(mean(recs.map((r) => r.events.filter((e) => e.ev === "eden.inject").length)), 2)}` +
        `  slow p50 ${f(quantile(dur("eden.slow"), 0.5), 0)} p90 ${f(quantile(dur("eden.slow"), 0.9), 0)}` +
        `  ask p50 ${f(quantile(dur("eden.ask"), 0.5), 0)} ms`,
    );
  }
}

// ---- The process: CPU (of one core) and memory, each second. Timing is noisy on a shared machine; CPU time less so.
if (samples.length) {
  const cpu = samples.map((s) => s.cpuPct);
  const user = samples.reduce((n, s) => n + s.userMs, 0);
  const system = samples.reduce((n, s) => n + s.systemMs, 0);
  console.log(
    `\n== process: ${samples.length} s sampled, CPU p50 ${f(quantile(cpu, 0.5), 1)}% p90 ${f(quantile(cpu, 0.9), 1)}%` +
      ` max ${f(Math.max(...cpu), 1)}% of a core; CPU time user ${f(user / 1_000, 1)} s system ${f(system / 1_000, 1)} s` +
      ` (${f((user + system) / Math.max(1, ok.length), 0)} ms per run); RSS max ${f(Math.max(...samples.map((s) => s.rssMb)), 1)} MB` +
      `; tasks in flight max ${Math.max(...samples.map((s) => s.tasks))}`,
  );
}

/**
 * `--reconcile report.txt --ledger ledger-summary.jsonl --run p3-h-h13-`: the cost columns of a report written before
 * results files recorded background spend, recomputed at $0 from the report's own outcome tables and the spend
 * ledger's per-run totals (the Haiku campaign's raw results are not kept). The ledger's `eden.cards` and `eden.bridge`
 * spend of the runs named `--run`* is spread evenly over every task run of a condition with a partner (a name with
 * `eden`, or starting `both`: ALL3 and the NEW family all had cards on), as `backfillShares` spreads it per seed: the
 * same share per run when every seed ran the same tasks, as the campaign's did. It then checks that the per-task column
 * plus the backfill, over every row, adds up to the report's own Eden total, and returns false when it does not.
 */
function reconcile(reportFile: string, ledgerFile: string, run: string): boolean {
  if (!ledgerFile || !run) throw new Error("--reconcile needs --ledger FILE and --run PREFIX");
  const lines = readFileSync(reportFile, "utf8").split("\n");
  const total = Number(/Eden \$([\d.]+)/.exec(lines[1] ?? "")?.[1] ?? NaN);
  const ledger = readFileSync(ledgerFile, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { run: string; role: string; usd: number })
    .filter((l) => l.run.startsWith(run));
  const usd = (pred: (role: string) => boolean) => ledger.filter((l) => pred(l.role)).reduce((n, l) => n + l.usd, 0);
  const isBg = (role: string) => role === "eden.cards" || role === "eden.bridge";
  const bgUsd = usd(isBg);
  const taskUsd = usd((role) => role.startsWith("eden.") && !isBg(role));
  // The outcome tables: from a "== <kind>" heading to the next blank line, all before the critical path.
  const rows: { kind: string; c: string; n: number; perK: number; eden: number }[] = [];
  let kind = "";
  for (const line of lines) {
    if (line.startsWith("== critical path")) break;
    const head = /^== (hidden|control|request|arrival|offworld)/.exec(line);
    if (head) kind = head[1]!;
    else if (!line.trim()) kind = "";
    else if (kind && !line.startsWith("condition")) {
      const [c, n, , perK, eden] = line.trim().split(/\s+/);
      rows.push({ kind, c: c!, n: Number(n), perK: Number(perK), eden: Number(eden) });
    }
  }
  const withPartner = (c: string) => /eden|^both/.test(c);
  const runsWith = rows.filter((r) => withPartner(r.c)).reduce((n, r) => n + r.n, 0);
  const perK = runsWith ? (1_000 * bgUsd) / runsWith : 0;
  const bf = (c: string) => (withPartner(c) ? perK : 0);
  const x = (v: number, d = 3) => v.toFixed(d);
  console.log(
    `${reportFile}: ledger runs ${run}*: Eden per-task calls $${x(taskUsd, 4)}, background (cards, bridge) ` +
      `$${x(bgUsd, 4)}, spread over ${runsWith} task runs with a partner: $${x(perK)} per 1k`,
  );
  console.log(
    "kind     condition             n  agent+Eden $/1k  Eden reader only  Eden bkfill  Eden all-in  all-in $/1k",
  );
  for (const r of rows) {
    console.log(
      `${r.kind.padEnd(8)} ${r.c.padEnd(18)} ${String(r.n).padStart(4)} ${x(r.perK).padStart(16)} ` +
        `${x(r.eden).padStart(17)} ${x(bf(r.c)).padStart(12)} ${x(r.eden + bf(r.c)).padStart(12)} ` +
        `${x(r.perK + bf(r.c)).padStart(12)}`,
    );
  }
  const column = rows.reduce((n, r) => n + (r.eden * r.n) / 1_000, 0);
  const allIn = rows.reduce((n, r) => n + ((r.eden + bf(r.c)) * r.n) / 1_000, 0);
  const off = Math.abs(allIn - total);
  console.log(
    `reconcile: Σ (Eden) × n = $${x(column, 4)} (ledger per-task $${x(taskUsd, 4)}); Σ (Eden + bkfill) × n = ` +
      `$${x(allIn, 4)} against the header's Eden $${x(total, 4)}: off by $${x(off, 4)} ` +
      (off <= 0.01 ? "(within $0.01: OK)" : "(MORE THAN $0.01: the columns do not add up)"),
  );
  // NaN (no Eden total in the header) fails too.
  return off <= 0.01;
}
