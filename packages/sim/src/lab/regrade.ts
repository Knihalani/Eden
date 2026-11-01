#!/usr/bin/env bun
/**
 * Grades a finished A/B run's answers again with other graders, to choose a grader that grades reliably (free models
 * in particular: docs/research/edge-freelab.md). Reads a results file of `pi-ab.ts` or `agent-ab.ts` (its tasks and
 * answers), sends each answer to each grader with the same prompt (`gradeMessages`), and reports per grader:
 *
 * - readable: replies that gave a verdict for every needed fact (`readVerdicts`; JSON mode, fenced, or prose);
 * - errors: calls that failed (after the pacer's retries), and the cap's refusals;
 * - agreement: fact verdicts equal to the run's own grader's (where it graded), and to each other grader's.
 *
 *   OPENROUTER_API_KEY=… bun packages/sim/src/lab/regrade.ts --results pi-ab.json
 *     --graders cohere/north-mini-code:free,dots-studio/dots-3-note-preview:free [--limit 4] [--out regrade.json]
 *     [--allow-logging] [--rpm 18] [--max-requests N]
 *
 * One request per answer per grader (plus retries). The answers are sim data.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { chat, gradeMessages, readVerdicts, type RunResult, type Task } from "./ab-common";
import { isCapError, labAccess } from "./free";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const RESULTS = opt("results", "");
if (!RESULTS) throw new Error("--results is required");
const GRADERS = opt("graders", "").split(",").filter(Boolean);
if (!GRADERS.length) throw new Error("--graders is required");
const LIMIT = Number(opt("limit", "0"));
const OUT = opt("out", "");
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) throw new Error("needs OPENROUTER_API_KEY");
const access = labAccess(args, GRADERS);

const run = JSON.parse(readFileSync(RESULTS, "utf8")) as { grader?: string; tasks: Task[]; results: RunResult[] };
const byId = new Map(run.tasks.map((t) => [t.id, t]));
let todo = run.results.filter((r) => !r.error && r.answer.trim() && byId.get(r.task)?.must.length);
if (LIMIT > 0) todo = todo.slice(0, LIMIT);

interface Graded {
  task: string;
  condition: string;
  grader: string;
  facts?: Record<string, boolean>;
  readable?: boolean;
  error?: string;
  ms?: number;
  reply?: string;
}
const graded: Graded[] = [];
const meter = { before: () => {}, after: () => {} };
for (const r of todo) {
  const task = byId.get(r.task)!;
  for (const grader of GRADERS) {
    const g: Graded = { task: r.task, condition: r.condition, grader };
    const t0 = performance.now();
    try {
      const via = { fetch: access.fetch, allowLogging: access.allowLogging };
      const { msg } = await chat(KEY, meter, grader, gradeMessages(task, r.answer), undefined, true, via);
      const verdicts = readVerdicts(msg.content ?? "");
      g.facts = Object.fromEntries(task.must.map((f, i) => [f.id, verdicts.get(String(i + 1)) === true]));
      g.readable = task.must.every((_, i) => verdicts.has(String(i + 1)));
      // The grader's reply on sim data, kept short for a reader checking a disagreement.
      g.reply = (msg.content ?? "").slice(-200);
    } catch (e) {
      g.error = isCapError(e) ? "request cap reached" : e instanceof Error ? e.message.slice(0, 160) : String(e);
    }
    g.ms = Math.round(performance.now() - t0);
    graded.push(g);
    console.error(`${r.task} ${r.condition} ${grader}: ${g.error ?? JSON.stringify(g.facts)} (${g.ms}ms)`);
  }
}

/** Fact-level agreement of two verdict sets over the facts both graded. */
const agree = (a?: Record<string, boolean>, b?: Record<string, boolean>) => {
  if (!a || !b) return { same: 0, of: 0 };
  const keys = Object.keys(a).filter((k) => k in b);
  return { same: keys.filter((k) => a[k] === b[k]).length, of: keys.length };
};
const sum = (xs: { same: number; of: number }[]) =>
  xs.reduce((s, x) => ({ same: s.same + x.same, of: s.of + x.of }), { same: 0, of: 0 });
const summary = GRADERS.map((grader) => {
  const mine = graded.filter((g) => g.grader === grader);
  const original = sum(
    mine.map((g) => agree(g.facts, todo.find((r) => r.task === g.task && r.condition === g.condition)?.facts)),
  );
  const others = Object.fromEntries(
    GRADERS.filter((o) => o !== grader).map((o) => [
      o,
      sum(mine.map((g) => agree(g.facts, graded.find((x) => x.grader === o && x.task === g.task)?.facts))),
    ]),
  );
  return {
    grader,
    answers: mine.length,
    readable: mine.filter((g) => g.readable).length,
    errors: mine.filter((g) => g.error).length,
    msMedian: mine.map((g) => g.ms ?? 0).sort((a, b) => a - b)[Math.floor(mine.length / 2)] ?? 0,
    factsTrue: mine.reduce((n, g) => n + Object.values(g.facts ?? {}).filter(Boolean).length, 0),
    agreeWithRun: original,
    agreeWith: others,
  };
});
const out = { results: RESULTS, runGrader: run.grader, summary, requests: access.pacer.summary(), graded };
console.log(JSON.stringify({ runGrader: run.grader, summary, requests: out.requests }, null, 2));
if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 2));
