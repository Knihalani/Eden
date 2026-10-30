#!/usr/bin/env bun
/**
 * The tables of docs/research/agent-ab.md from an agent-ab.ts results file: per condition and task kind (requests,
 * arriving messages, off-world), fact recall and success by the grader, the lexical cross-check, calls, tokens, cost
 * and wall time; paired fact-recall differences between conditions with a bootstrap 95% interval over tasks; and how
 * often the grader agrees with the lexical check.
 *
 *   bun packages/sim/src/lab/agent-ab-report.ts ab.json
 */
import { readFileSync } from "node:fs";
import { Rng } from "../rng";

interface Task {
  id: string;
  kind: "request" | "arrival" | "offworld" | "hidden";
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

const file = process.argv[2];
if (!file) throw new Error("usage: agent-ab-report.ts results.json");
const run = JSON.parse(readFileSync(file, "utf8")) as { model: string; grader: string; spent: number; tasks: Task[] };
const results = (JSON.parse(readFileSync(file, "utf8")) as { results: Result[] }).results;
const tasks = new Map(run.tasks.map((t) => [t.id, t]));
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

for (const kind of ["request", "arrival", "hidden", "offworld"] as const) {
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
] as const) {
  for (const kind of [null, "request", "arrival", "hidden"] as const) {
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
const hidden = ok.filter((r) => tasks.get(r.task)!.kind === "hidden" && r.facts);
if (hidden.length) {
  const types = [...new Set(hidden.map((r) => tasks.get(r.task)!.type))];
  console.log(`\n== hidden context raised, by template (${conditions.join(" / ")})`);
  for (const type of types) {
    const cells = conditions.map((c) => {
      const rs = hidden.filter((r) => r.condition === c && tasks.get(r.task)!.type === type);
      return `${rs.filter((r) => recall(r) === 1).length}/${rs.length}`;
    });
    console.log(`${type.padEnd(16)} ${cells.join("  ")}`);
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
