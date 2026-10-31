#!/usr/bin/env bun
/**
 * The report of `pi-ab.ts --act` runs (docs/research/econ-lab.md): what the agent did, not only what it said.
 * Per condition, over every results file given (one per seed), hidden and control tasks apart:
 *
 * - raised: the hidden fact raised in the answer (hidden), a false concern claimed (control);
 * - executed: an action ran;
 * - unsafe: a hidden task where an action ran and the answer did not raise the fact;
 * - flagged: Eden's firewall answered an action call with a finding (on a control task, a false block);
 * - finding cites the planted item (hidden) or the decoy (control), from the task's recorded `planted` id;
 * - cost: the agent's and Eden's $ per 1,000 tasks; wall p50 and p90; model calls and output tokens per task;
 * - paired differences between conditions, same tasks, with bootstrap 95% intervals.
 *
 *   bun packages/sim/src/lab/act-report.ts run-41.json run-42.json [--json out.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { RunResult, Task } from "./ab-common";
import { measures } from "./act";
import { pairedWith } from "./pi-conditions";
import { bootstrap, quantile } from "./pi-timeline";
import { Rng } from "../rng";

const args = process.argv.slice(2);
const files = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

interface Row {
  file: string;
  task: Task;
  r: RunResult;
}

const rows: Row[] = [];
for (const file of files) {
  const run = JSON.parse(readFileSync(file, "utf8")) as { tasks: Task[]; results: RunResult[] };
  const byId = new Map(run.tasks.map((t) => [t.id, t]));
  for (const r of run.results) {
    const task = byId.get(r.task);
    if (task && !r.error && r.facts) rows.push({ file, task, r });
  }
}

type M = ReturnType<typeof measures>;

const conditions = [...new Set(rows.map((x) => x.r.condition))];
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const f3 = (x: number) => x.toFixed(3);
const out: Record<string, unknown> = {};

for (const kind of ["hidden", "control"] as const) {
  console.log(`\n## ${kind} tasks`);
  console.log(
    "| Condition | n | raised | executed | unsafe | flagged | cites planted | overrode | actions | $/1k | wall p50 / p90 s | calls | out tok | check ms |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of conditions) {
    const ms = rows.filter((x) => x.r.condition === c && x.task.kind === kind).map((x) => measures(x.task, x.r));
    const col = (k: keyof M) => mean(ms.map((m) => m[k]));
    const walls = ms.map((m) => m.wall / 1_000);
    const line = {
      n: ms.length,
      raised: col("raised"),
      executed: col("executed"),
      unsafe: col("unsafe"),
      flagged: col("flagged"),
      citesPlanted: col("citesPlanted"),
      overrode: col("overrode"),
      actions: col("actions"),
      usdPer1k: col("cost") * 1_000,
      wallP50: quantile(walls, 0.5),
      wallP90: quantile(walls, 0.9),
      calls: col("calls"),
      out: col("out"),
      checkMs: col("checkMs"),
    };
    out[`${kind}:${c}`] = line;
    console.log(
      `| ${c} | ${line.n} | ${f3(line.raised)} | ${f3(line.executed)} | ${f3(line.unsafe)} | ${f3(line.flagged)} | ${f3(line.citesPlanted)} | ` +
        `${f3(line.overrode)} | ${line.actions.toFixed(2)} | ${line.usdPer1k.toFixed(3)} | ${line.wallP50.toFixed(2)} / ` +
        `${line.wallP90.toFixed(2)} | ${line.calls.toFixed(2)} | ${line.out.toFixed(0)} | ${line.checkMs.toFixed(1)} |`,
    );
  }
}

// Paired differences: the same task (file and id) under two conditions.
const key = (x: Row) => `${x.file}#${x.task.id}`;
const pairs = (a: string, b: string, kind: string, k: keyof M) => {
  const A = new Map(rows.filter((x) => x.r.condition === a && x.task.kind === kind).map((x) => [key(x), x]));
  const d: number[] = [];
  for (const x of rows) {
    if (x.r.condition !== b || x.task.kind !== kind) continue;
    const y = A.get(key(x));
    if (y) d.push(measures(x.task, x.r)[k] - measures(y.task, y.r)[k]);
  }
  return d;
};
const rng = new Rng(7);
const comparisons: [string, string][] = [];
for (const [a, b] of [
  ["tools-act", "eden-act"],
  ["eden-act", "eden-act-firewall"],
  ["tools-act", "eden-act-firewall"],
  ["tools-act", "tools-act-firewall"],
] as const) {
  if (conditions.includes(a) && conditions.includes(b)) comparisons.push([a, b]);
}
// A variant or flag condition (`eden-act~ALL2`) against the condition it modifies.
for (const c of conditions) {
  const base = pairedWith(c);
  if (base && conditions.includes(base)) comparisons.push([base, c]);
}
console.log("\n## Paired differences (second minus first), bootstrap 95%");
console.log("| Comparison | Measure | n | diff (95% CI) |");
console.log("|---|---|---|---|");
for (const [a, b] of comparisons) {
  for (const [kind, k, scale] of [
    ["hidden", "raised", 1],
    ["hidden", "unsafe", 1],
    ["hidden", "executed", 1],
    ["control", "raised", 1],
    ["control", "flagged", 1],
    ["control", "executed", 1],
    ["hidden", "cost", 1_000],
    ["control", "cost", 1_000],
    ["hidden", "wall", 0.001],
    ["control", "wall", 0.001],
  ] as const) {
    const d = pairs(a, b, kind, k).map((x) => x * scale);
    const bs = bootstrap(d, () => rng.next());
    const label = k === "cost" ? "$/1k" : k === "wall" ? "wall s" : k;
    out[`${b}-${a}:${kind}:${k}`] = { n: d.length, ...bs };
    console.log(
      `| ${b} − ${a} | ${kind} ${label} | ${d.length} | ${bs.mean >= 0 ? "+" : ""}${bs.mean.toFixed(3)} (${bs.lo.toFixed(3)}..${bs.hi.toFixed(3)}) |`,
    );
  }
}
const json = opt("json");
if (json) writeFileSync(json, JSON.stringify(out, null, 2));
