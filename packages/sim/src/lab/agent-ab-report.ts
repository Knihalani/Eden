#!/usr/bin/env bun
/**
 * The tables of docs/research/agent-ab.md from an agent-ab.ts results file: per condition and task kind (requests,
 * arriving messages, off-world), fact recall and success by the grader, the lexical cross-check, calls, tokens, cost
 * and wall time; paired fact-recall differences between conditions with a bootstrap 95% interval over tasks; and how
 * often the grader agrees with the lexical check.
 *
 *   bun packages/sim/src/lab/agent-ab-report.ts ab.json [more.json ...] [--record [label]] [--note text]
 *
 * Several results files are merged: their tasks and results pooled, a task run under the same condition in two files
 * kept from the later file. The hidden-context tasks also get a per-suite table (suites.ts).
 */
import { readFileSync } from "node:fs";
import { Rng } from "../rng";
import { record, tidy } from "./ledger";

interface Task {
  id: string;
  /** Absent in results files written before suites.ts: then read from the id. */
  suite?: string;
  kind: "request" | "arrival" | "offworld" | "hidden" | "control";
  type: string;
  must: { id: string; detail: string }[];
}
interface Result {
  task: string;
  condition: string;
  answer: string;
  modelCalls: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  edenCostUsd?: number;
  edenModelCalls?: number;
  injectedItems: number;
  lateItems?: number;
  wallMs: number;
  error?: string;
  facts?: Record<string, boolean>;
  leaked?: boolean;
}

// Positional arguments are results files; `--record` takes an optional label and `--note` a value.
const argv = process.argv.slice(2);
const files: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--note") i++;
  else if (a === "--record") {
    if (argv[i + 1] && !argv[i + 1]!.startsWith("--") && !argv[i + 1]!.endsWith(".json")) i++;
  } else if (!a.startsWith("--")) files.push(a);
}
if (!files.length) throw new Error("usage: agent-ab-report.ts results.json [more.json ...]");
interface RunFile {
  model: string;
  grader: string;
  spent: number;
  seeds?: number[];
  tasks: Task[];
  results: Result[];
}
const runs = files.map((f) => JSON.parse(readFileSync(f, "utf8")) as RunFile);
const joined = (xs: string[]) => [...new Set(xs)].join(",");
const run = {
  model: joined(runs.map((r) => r.model)),
  grader: joined(runs.map((r) => r.grader)),
  spent: runs.reduce((n, r) => n + r.spent, 0),
  seeds: [...new Set(runs.flatMap((r) => r.seeds ?? []))],
  tasks: [...new Map(runs.flatMap((r) => r.tasks).map((t) => [t.id, t])).values()],
};
// The later file wins for a task run under the same condition.
const results = [...new Map(runs.flatMap((r) => r.results).map((r) => [`${r.task}\u0000${r.condition}`, r])).values()];
const tasks = new Map(run.tasks.map((t) => [t.id, t]));
/** A task's suite: recorded, or the id's second part (`w41:heldout2-control:<template>`) for hidden-context tasks. */
const suiteOf = (t: Task) =>
  t.suite ??
  (t.kind === "hidden" || t.kind === "control" ? (t.id.split(":")[1] ?? "hidden").replace(/-control$/, "") : "lookups");
const conditions = [...new Set(results.map((r) => r.condition))];
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const STOP = new Set("the a an at on in of to for and or with by from is are be not before after".split(" "));
/** A fact's distinctive tokens: words of three or more letters and anything with a digit or a currency sign. */
const tokens = (s: string) =>
  (
    s
      .toLowerCase()
      .replace(/,/g, "")
      .match(/[a-z0-9£$€%]+(?:[.:][0-9]+)*/g) ?? []
  ).filter((w) => !STOP.has(w) && (w.length >= 3 || /\d/.test(w)));
/** The lexical check: 70% of a fact's distinctive tokens appear in the answer. */
const lexical = (detail: string, answer: string) => {
  const t = tokens(detail);
  const a = answer.toLowerCase().replace(/,/g, "");
  return t.length > 0 && t.filter((w) => a.includes(w)).length / t.length >= 0.7;
};
const recall = (r: Result) => {
  const must = tasks.get(r.task)!.must;
  return must.filter((m) => r.facts?.[m.id]).length / Math.max(1, must.length);
};

const ok = results.filter((r) => !r.error && tasks.has(r.task));
const ungraded = ok.filter((r) => tasks.get(r.task)!.kind !== "offworld" && !r.facts).length;
console.log(`model ${run.model}, grader ${run.grader}, spent $${run.spent.toFixed(4)}, ${results.length} runs`);
console.log(`errors ${results.length - ok.length}, ungraded ${ungraded}${ungraded ? " (left out of recall)" : ""}`);

for (const kind of ["request", "arrival", "hidden", "control", "offworld"] as const) {
  console.log(`\n== ${kind}`);
  for (const c of conditions) {
    const rs = ok.filter((r) => r.condition === c && tasks.get(r.task)!.kind === kind);
    if (!rs.length) continue;
    const graded = rs.filter((r) => r.facts);
    const success = mean(graded.map((r) => (recall(r) === 1 ? 1 : 0)));
    const lexicalRecall = mean(
      rs.map((r) => mean(tasks.get(r.task)!.must.map((m) => (lexical(m.detail, r.answer) ? 1 : 0)))),
    );
    const facts =
      kind === "offworld"
        ? ""
        : ` facts ${mean(graded.map(recall)).toFixed(3)} success ${success.toFixed(3)}` +
          ` lexical ${lexicalRecall.toFixed(3)}`;
    const wall = rs.map((r) => r.wallMs).sort((a, b) => a - b)[Math.floor(rs.length / 2)]! / 1000;
    console.log(
      `${c.padEnd(11)} n=${String(rs.length).padStart(3)}${facts}` +
        ` calls ${mean(rs.map((r) => r.modelCalls)).toFixed(2)} tools ${mean(rs.map((r) => r.toolCalls)).toFixed(2)}` +
        ` in ${mean(rs.map((r) => r.promptTokens)).toFixed(0)} out ${mean(rs.map((r) => r.completionTokens)).toFixed(0)}` +
        ` injected ${mean(rs.map((r) => r.injectedItems)).toFixed(2)} late ${mean(rs.map((r) => r.lateItems ?? 0)).toFixed(2)}` +
        ` edenCalls ${mean(rs.map((r) => r.edenModelCalls ?? 0)).toFixed(2)}` +
        ` $/1k ${(1000 * mean(rs.map((r) => r.costUsd + (r.edenCostUsd ?? 0)))).toFixed(3)} p50 ${wall.toFixed(1)}s` +
        ` leaks ${rs.filter((r) => r.leaked).length}`,
    );
  }
}

// Paired differences: the same task under two conditions; a bootstrap over tasks for the interval.
const byTask = new Map<string, Map<string, number>>();
for (const r of ok) {
  if (tasks.get(r.task)!.kind === "offworld" || !r.facts) continue;
  if (!byTask.has(r.task)) byTask.set(r.task, new Map());
  byTask.get(r.task)!.set(r.condition, recall(r));
}
const rng = new Rng(1);
console.log("\n== paired fact-recall differences, bootstrap 95% interval");
for (const [a, b] of [
  ["eden", "tools"],
  ["both", "tools"],
  ["eden-judge", "tools"],
  ["both-judge", "tools"],
  ["eden-judge", "eden"],
  ["both-judge", "both"],
  ["eden+p", "eden"],
  ["both+p", "both"],
  ["eden-judge+p", "eden-judge"],
  ["both-judge+p", "both-judge"],
  ["eden-judge+p", "tools"],
  ["both-judge+p", "tools"],
] as const) {
  // Pooled only where the kinds measure one thing: a hidden task's hit and a control's false alarm do not add.
  const mixed = run.tasks.some((t) => t.kind === "control");
  for (const kind of [mixed ? undefined : null, "request", "arrival", "hidden", "control"] as const) {
    if (kind === undefined) continue;
    const xs = [...byTask]
      .filter(([t, v]) => v.has(a) && v.has(b) && (kind === null || tasks.get(t)!.kind === kind))
      .map(([, v]) => v.get(a)! - v.get(b)!);
    if (!xs.length) continue;
    const boots = Array.from({ length: 2_000 }, () => mean(xs.map(() => xs[Math.floor(rng.next() * xs.length)]!))).sort(
      (x, y) => x - y,
    );
    const f = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);
    console.log(
      `${a.padEnd(10)} - ${b.padEnd(6)} ${(kind ?? "all").padEnd(8)} n=${String(xs.length).padStart(3)} ${f(mean(xs))}` +
        ` (${f(boots[50]!)}..${f(boots[1_949]!)})`,
    );
  }
}

// Hidden-context tasks: how many of each template's tasks each condition raised the hidden fact on.
for (const kind of ["hidden", "control"] as const) {
  const hidden = ok.filter((r) => tasks.get(r.task)!.kind === kind && r.facts);
  if (!hidden.length) continue;
  const types = [...new Set(hidden.map((r) => tasks.get(r.task)!.type))];
  const what = kind === "hidden" ? "hidden context raised" : "false concern raised (control)";
  console.log(`\n== ${what}, by template (${conditions.join(" / ")})`);
  for (const type of types) {
    const cells = conditions.map((c) => {
      const rs = hidden.filter((r) => r.condition === c && tasks.get(r.task)!.type === type);
      return `${rs.filter((r) => recall(r) === 1).length}/${rs.length}`;
    });
    console.log(`${type.padEnd(16)} ${cells.join("  ")}`);
  }
}

// Per suite: how often each condition raised the hidden fact (hidden tasks) and a false concern (control tasks).
const hiddenSuites = [...new Set(run.tasks.filter((t) => t.kind === "hidden" || t.kind === "control").map(suiteOf))];
const suiteRate = (c: string, suite: string, kind: "hidden" | "control") => {
  const rs = ok.filter(
    (r) => r.condition === c && r.facts && tasks.get(r.task)!.kind === kind && suiteOf(tasks.get(r.task)!) === suite,
  );
  return { hit: rs.filter((r) => recall(r) === 1).length, n: rs.length };
};
if (hiddenSuites.length) {
  console.log("\n== by suite: hidden fact raised / false concern raised (control)");
  for (const suite of hiddenSuites) {
    for (const c of conditions) {
      const h = suiteRate(c, suite, "hidden");
      const f = suiteRate(c, suite, "control");
      if (!h.n && !f.n) continue;
      const cell = (x: { hit: number; n: number }) =>
        x.n ? `${`${x.hit}/${x.n}`.padStart(7)} ${(x.hit / x.n).toFixed(3)}` : `${"-".padStart(7)}      `;
      console.log(`${suite.padEnd(10)} ${c.padEnd(13)} hidden ${cell(h)}   false-concern ${cell(f)}`);
    }
  }
}

let agree = 0;
let total = 0;
for (const r of ok) {
  if (!r.facts) continue;
  for (const m of tasks.get(r.task)!.must) {
    total++;
    if ((r.facts[m.id] ?? false) === lexical(m.detail, r.answer)) agree++;
  }
}
console.log(
  `\ngrader and lexical check agree on ${agree} of ${total} facts (${(agree / Math.max(1, total)).toFixed(3)})`,
);

// `--record [label]`: the run's summary and every result into the benchmark ledger (bench/, ledger.ts).
const at = process.argv.indexOf("--record");
if (at >= 0) {
  const next = process.argv[at + 1];
  const label = next && !next.startsWith("--") && !next.endsWith(".json") ? next : "agent";
  const metrics: Record<string, number> = { graderAgreement: agree / Math.max(1, total), runs: results.length };
  const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)] ?? 0;
  for (const c of conditions) {
    for (const kind of ["request", "arrival", "hidden", "control", "offworld"] as const) {
      const rs = ok.filter((r) => r.condition === c && tasks.get(r.task)!.kind === kind);
      if (!rs.length) continue;
      const g = rs.filter((r) => r.facts);
      const k = `${c}.${kind}`;
      if (kind !== "offworld") {
        metrics[`${k}.hit`] = mean(g.map(recall));
        metrics[`${k}.success`] = mean(g.map((r) => (recall(r) === 1 ? 1 : 0)));
      }
      metrics[`${k}.n`] = rs.length;
      metrics[`${k}.modelCalls`] = mean(rs.map((r) => r.modelCalls));
      metrics[`${k}.toolCalls`] = mean(rs.map((r) => r.toolCalls));
      metrics[`${k}.inTokens`] = mean(rs.map((r) => r.promptTokens));
      metrics[`${k}.outTokens`] = mean(rs.map((r) => r.completionTokens));
      metrics[`${k}.costPer1k`] = 1000 * mean(rs.map((r) => r.costUsd + (r.edenCostUsd ?? 0)));
      metrics[`${k}.edenCalls`] = mean(rs.map((r) => r.edenModelCalls ?? 0));
      metrics[`${k}.injected`] = mean(rs.map((r) => r.injectedItems));
      metrics[`${k}.late`] = mean(rs.map((r) => r.lateItems ?? 0));
      metrics[`${k}.wallP50`] =
        q(
          rs.map((r) => r.wallMs),
          0.5,
        ) / 1000;
      metrics[`${k}.wallP95`] =
        q(
          rs.map((r) => r.wallMs),
          0.95,
        ) / 1000;
      metrics[`${k}.leaks`] = rs.filter((r) => r.leaked).length;
    }
    for (const suite of hiddenSuites) {
      const h = suiteRate(c, suite, "hidden");
      const f = suiteRate(c, suite, "control");
      if (h.n) metrics[`${c}.suite.${suite}.hidden`] = h.hit / h.n;
      if (f.n) metrics[`${c}.suite.${suite}.falseConcern`] = f.hit / f.n;
    }
  }
  const rows = results.map((r) => {
    const t = tasks.get(r.task);
    return {
      task: r.task,
      kind: t?.kind,
      template: t?.type,
      condition: r.condition,
      hit: r.facts ? recall(r) : null,
      facts: r.facts ?? null,
      modelCalls: r.modelCalls,
      toolCalls: r.toolCalls,
      inTokens: r.promptTokens,
      outTokens: r.completionTokens,
      costUsd: r.costUsd,
      edenCostUsd: r.edenCostUsd ?? 0,
      edenModelCalls: r.edenModelCalls ?? 0,
      injected: r.injectedItems,
      late: r.lateItems ?? 0,
      wallMs: Math.round(r.wallMs),
      leaked: !!r.leaked,
      error: r.error ?? null,
      answer: r.answer.slice(0, 300),
    };
  });
  // The suites run, in order; a lookups-only run stays "lookups" as before.
  const suite = joined(run.tasks.map(suiteOf));
  const e = record(
    {
      tier: "agent",
      suite,
      label,
      config: { conditions },
      seeds: run.seeds,
      models: { agent: run.model, grader: run.grader },
      costUsd: Number(run.spent.toFixed(4)),
      wallSeconds: 0,
      metrics: tidy(metrics),
      ...(process.argv.includes("--note") ? { note: process.argv[process.argv.indexOf("--note") + 1] } : {}),
    },
    rows,
  );
  console.log(`recorded ${e.id}`);
}
