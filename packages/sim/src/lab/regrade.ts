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
 * A `claude-*` grader is Anthropic's API through the lab provider (D97), metered on a spend ledger with a hard cap, and
 * needs no OpenRouter key (fix-s3b: a stronger grader regrades a Haiku-graded run):
 *
 *   env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results pi-ab.json --graders claude-sonnet-5-5
 *     --spend-ledger .local/ledger.jsonl --spend-cap 4 --spend-headroom 0.3 --run-label regrade [--out regrade.json]
 *     [--only-concerns]
 *
 * `--only-concerns` (fix-w2b) regrades only the control and neutral answers the run's grader called a concern (any fact
 * true): a check of the false concerns themselves, at a few cents rather than a whole run's worth. `--only-misses` (A2)
 * regrades only the hidden answers it called a miss (no fact true); `--conditions a,b` keeps those arms' answers.
 * `--kinds hidden`, `--only-raised` and `--sample N` (A12) keep a task kind, the hidden answers called raised, and a
 * fixed pseudo-random N of the rest: a Sonnet check of a Haiku-graded run's hidden rate (docs/research/a12-quality.md).
 *
 * The summary also splits agreement with the run's grader by task kind (hidden, control, neutral), with the counts of
 * facts each grader alone called true, since a disagreement on a control or neutral task moves the false-concern rate.
 *
 * One request per answer per grader (plus retries). The answers are sim data.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Model } from "@eden/llm";
import { chat, gradeMessages, readVerdicts, type RunResult, type Task } from "./ab-common";
import { isAnthropic, isCapError, labAccess, labModel } from "./free";
import { byKind, isConcern, isMiss } from "./regrade-kinds";

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
if (!KEY && GRADERS.some((g) => !isAnthropic(g))) throw new Error("an OpenRouter grader needs OPENROUTER_API_KEY");
const access = labAccess(args, GRADERS);

const run = JSON.parse(readFileSync(RESULTS, "utf8")) as { grader?: string; tasks: Task[]; results: RunResult[] };
const byId = new Map(run.tasks.map((t) => [t.id, t]));
let todo = run.results.filter((r) => !r.error && r.answer.trim() && byId.get(r.task)?.must.length);
if (args.includes("--only-concerns")) todo = todo.filter((r) => isConcern(byId.get(r.task)!.kind, r.facts));
if (args.includes("--only-misses")) todo = todo.filter((r) => isMiss(byId.get(r.task)!.kind, r.facts));
const CONDITIONS = opt("conditions", "") ? new Set(opt("conditions", "").split(",")) : null;
if (CONDITIONS) todo = todo.filter((r) => CONDITIONS.has(r.condition));
// `--kinds hidden` (A12) keeps those task kinds; `--only-raised` the hidden answers the run's grader called raised;
// `--sample N` a fixed pseudo-random N of what is left (by a hash of task and arm: the same N on every rerun), so a
// stronger grader can check a cheaper one's "raised" calls at a few cents.
const KINDS = opt("kinds", "") ? new Set(opt("kinds", "").split(",")) : null;
if (KINDS) todo = todo.filter((r) => KINDS.has(byId.get(r.task)!.kind));
if (args.includes("--only-raised")) {
  todo = todo.filter((r) => byId.get(r.task)!.kind === "hidden" && !isMiss("hidden", r.facts));
}
const SAMPLE = Number(opt("sample", "0"));
if (SAMPLE > 0) {
  const hash = (x: string) => [...x].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16_777_619) >>> 0, 2_166_136_261);
  todo = todo
    .map((r) => ({ r, h: hash(`${r.task}\u0000${r.condition}`) }))
    .sort((a, b) => a.h - b.h)
    .slice(0, SAMPLE)
    .map((x) => x.r);
}
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
  usd?: number;
}
const graded: Graded[] = [];
const anthropicModels = new Map<string, Model>();
const anthropicGrader = (id: string): Model => {
  let m = anthropicModels.get(id);
  if (!m) anthropicModels.set(id, (m = labModel(access, { apiKey: "", model: id }, "grader")));
  return m;
};
const meter = { before: () => {}, after: () => {} };
for (const r of todo) {
  const task = byId.get(r.task)!;
  for (const grader of GRADERS) {
    const g: Graded = { task: r.task, condition: r.condition, grader };
    const t0 = performance.now();
    try {
      let content: string;
      if (isAnthropic(grader)) {
        // The request `gradeWith` sends (pi-ab's Anthropic grader): same prompt, cap and JSON mode, on the ledger.
        const messages = gradeMessages(task, r.answer).map((m) => ({
          role: m.role as "system" | "user" | "assistant",
          content: String(m.content ?? ""),
        }));
        const res = await anthropicGrader(grader).chat({ messages, maxTokens: 2_000, json: true });
        g.usd = res.costUsd ?? 0;
        content = res.text;
      } else {
        const via = { fetch: access.fetch, allowLogging: access.allowLogging };
        const { msg } = await chat(KEY!, meter, grader, gradeMessages(task, r.answer), undefined, true, via);
        content = msg.content ?? "";
      }
      const verdicts = readVerdicts(content);
      g.facts = Object.fromEntries(task.must.map((f, i) => [f.id, verdicts.get(String(i + 1)) === true]));
      g.readable = task.must.every((_, i) => verdicts.has(String(i + 1)));
      // The grader's reply on sim data, kept short for a reader checking a disagreement.
      g.reply = content.slice(-200);
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
    usd: mine.reduce((n, g) => n + (g.usd ?? 0), 0),
    // Per task kind: agreement with the run's grader, and the facts only one of them called true.
    byKind: byKind(
      mine.map((g) => ({
        kind: byId.get(g.task)?.kind ?? "hidden",
        mine: g.facts,
        run: todo.find((r) => r.task === g.task && r.condition === g.condition)?.facts,
      })),
    ),
  };
});
const out = { results: RESULTS, runGrader: run.grader, summary, requests: access.pacer.summary(), graded };
console.log(JSON.stringify({ runGrader: run.grader, summary, requests: out.requests }, null, 2));
if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 2));
