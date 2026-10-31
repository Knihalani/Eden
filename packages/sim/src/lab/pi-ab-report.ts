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
 */
import { existsSync, readFileSync } from "node:fs";
import { Rng } from "../rng";
import type { RunResult, Task } from "./ab-common";
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
} from "./timeline";

interface RunFile {
  model: string;
  grader: string;
  spent: number;
  spend?: { agent: number; eden: number; grader: number };
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
  requests: { startMs: number; firstTokenMs: number | null; endMs: number; in: number; out: number; cost: number }[];
  events: TimelineEvent[];
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
    "condition     n   rate   $/1k  (Eden)  calls  tools   in tok  out tok   p50 s   p90 s   p99 s  ttft p50 ms",
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

// ---- Paired differences: the same task under two conditions, a bootstrap over tasks for the 95% interval.
const byTask = new Map<string, Map<string, RunResult>>();
for (const r of ok) {
  if (!byTask.has(r.task)) byTask.set(r.task, new Map());
  byTask.get(r.task)!.set(r.condition, r);
}
const rng = new Rng(1);
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
// A wait variant ("both@w0") against its base condition.
for (const c of conditions) if (c.includes("@")) PAIRS.push([c, c.split("@")[0]!]);
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
  }
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

// ---- Eden's own work per task: its source calls, probe queries, cache hits, judge calls and slow path.
const edenConds = conditions.filter((c) => c !== "none" && c !== "tools");
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
