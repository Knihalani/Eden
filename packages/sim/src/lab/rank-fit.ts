#!/usr/bin/env bun
/**
 * Fits the learned no-model ranker (`packages/engine/src/rank.ts`, docs/research/smart-rank.md) on the funnel's ask
 * dump (`hidden-funnel.ts --ask --ask-diag`), and says what it would cite on suites it was not fitted on.
 *
 * Each task's ask is one ranking over its candidates (`decide.ts` facts). The loss is pairwise logistic with an L2
 * penalty, fitted by Newton's method on scaled fact differences (no dependency): in a hidden task the planted item
 * should outrank every other candidate; in a control task every other candidate should outrank the decoy (weighted
 * `--decoy-weight`). The weights are written on the raw facts (the scaling folded in), as `rank.ts` reads them.
 *
 * Leave-one-suite-out: each suite's answers are re-ranked by a model fitted on the other suites only, with the engine's
 * own policy (`rankAnswer` over the dump's exact pool, `--margin`), and the table pools those out-of-fold answers. The
 * in-sample and development suites only: a blind suite in the dump is refused.
 *
 *   bun packages/sim/src/lab/rank-fit.ts diag.jsonl [more.jsonl] [--lambda 1] [--decoy-weight 0.3] [--margin 5]
 *     [--out packages/engine/src/rank-weights.json] [--folds DIR]
 *
 * `--folds DIR` writes each fold's weights as DIR/<suite>.json (fitted without that suite), for an engine run of the
 * fold (`hidden-funnel.ts --suite <suite> --rank-model DIR/<suite>.json`).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { FACT_NAMES, rankAnswer, type Facts, type RankModel } from "@eden/engine";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const FILES = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (FILES.length === 0) throw new Error("usage: rank-fit.ts diag.jsonl [options]");
const LAMBDA = Number(opt("lambda", "1"));
const DECOY_WEIGHT = Number(opt("decoy-weight", "0.3"));
const MARGIN = Number(opt("margin", "5"));
const LIMIT = Number(opt("limit", "5"));
/** Facts the ranker reads: every fact but the request's own (equal across one ranking, so no pair can learn them). */
const REQUEST_FACTS = new Set<keyof Facts>(["acts", "imperative", "question", "hasDays", "external"]);
const NAMES = FACT_NAMES.filter((n) => !REQUEST_FACTS.has(n));
const D = NAMES.length;
/** Development suites, reported apart from the in-sample ones. */
const DEV = new Set(["dev6a", "dev6b"]);
const BLIND = /^heldout([5-9]|\d\d)$/;

interface Line {
  suite: string;
  variant: "hidden" | "control";
  planted: string;
  delivered: boolean;
  askCited: boolean;
  cited: string[];
  pool: string[];
  candidates: { id: string; facts: Facts }[];
}

const lines: Line[] = FILES.flatMap((f) =>
  readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line),
);
if (lines.some((l) => BLIND.test(l.suite))) throw new Error("a blind suite is in the dump: fit on dev and in-sample");
const vec = (f: Facts) => NAMES.map((n) => f[n]);

/** Pairwise logistic regression with an L2 penalty: weights on the raw facts. */
function fit(train: Line[]): number[] {
  const rows: { x: number[]; w: number }[] = [];
  for (const l of train) {
    const planted = l.candidates.find((c) => c.id === l.planted);
    if (!planted) continue;
    const p = vec(planted.facts);
    for (const c of l.candidates) {
      if (c.id === l.planted) continue;
      const o = vec(c.facts);
      if (l.variant === "hidden") rows.push({ x: p.map((v, j) => v - o[j]!), w: 1 });
      else rows.push({ x: o.map((v, j) => v - p[j]!), w: DECOY_WEIGHT });
    }
  }
  const scale = new Array<number>(D).fill(0);
  for (const r of rows) for (let j = 0; j < D; j++) scale[j]! += r.x[j]! ** 2 / Math.max(1, rows.length);
  for (let j = 0; j < D; j++) scale[j] = Math.sqrt(scale[j]!) || 1;
  const z = rows.map((r) => r.x.map((v, j) => v / scale[j]!));
  let beta = new Array<number>(D).fill(0);
  for (let iter = 0; iter < 40; iter++) {
    const grad = new Array<number>(D).fill(0);
    const hess = Array.from({ length: D }, () => new Array<number>(D).fill(0));
    rows.forEach((r, i) => {
      const zi = z[i]!;
      let s = 0;
      for (let j = 0; j < D; j++) s += beta[j]! * zi[j]!;
      const p = 1 / (1 + Math.exp(-s));
      const g = r.w * (p - 1);
      const h = r.w * p * (1 - p);
      for (let j = 0; j < D; j++) {
        grad[j]! += g * zi[j]!;
        for (let k = j; k < D; k++) hess[j]![k]! += h * zi[j]! * zi[k]!;
      }
    });
    for (let j = 0; j < D; j++) for (let k = 0; k < j; k++) hess[j]![k] = hess[k]![j]!;
    for (let j = 0; j < D; j++) {
      grad[j]! += LAMBDA * beta[j]!;
      hess[j]![j]! += LAMBDA;
    }
    const step = solve(hess, grad);
    beta = beta.map((b, j) => b - step[j]!);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  return beta.map((b, j) => b / scale[j]!);
}

/** Gaussian elimination with partial pivoting (D is small). */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r;
    [m[c], m[piv]] = [m[piv]!, m[c]!];
    const d = m[c]![c]! || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / d;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / (row[i]! || 1e-12));
}

/** The answer the engine would give with these weights: `rankAnswer` over the dump's pool. */
function answer(l: Line, w: number[]): string[] {
  const score = new Map(l.candidates.map((c) => [c.id, vec(c.facts).reduce((a, v, j) => a + v * w[j]!, 0)]));
  const pool = new Set(l.pool);
  const outside = l.candidates.map((c) => c.id).filter((id) => !pool.has(id));
  return rankAnswer(l.pool, outside, LIMIT, MARGIN, (id) => score.get(id));
}

interface Tally {
  hidden: number;
  either0: number;
  either1: number;
  cited0: number;
  cited1: number;
  control: number;
  decoy0: number;
  decoy1: number;
}
const tally = (): Tally => ({
  hidden: 0,
  either0: 0,
  either1: 0,
  cited0: 0,
  cited1: 0,
  control: 0,
  decoy0: 0,
  decoy1: 0,
});
const out: Record<"dev" | "in", Tally> = { dev: tally(), in: tally() };
const suites = [...new Set(lines.map((l) => l.suite))];
for (const held of suites) {
  const w = fit(lines.filter((l) => l.suite !== held));
  const t = out[DEV.has(held) ? "dev" : "in"];
  for (const l of lines.filter((x) => x.suite === held)) {
    const cited = answer(l, w).includes(l.planted);
    if (l.variant === "hidden") {
      t.hidden++;
      if (l.delivered || l.askCited) t.either0++;
      if (l.delivered || cited) t.either1++;
      if (l.askCited) t.cited0++;
      if (cited) t.cited1++;
    } else {
      t.control++;
      if (l.askCited) t.decoy0++;
      if (cited) t.decoy1++;
    }
  }
}
console.log(
  `leave-one-suite-out, ${suites.length} suites, lambda ${LAMBDA}, decoy weight ${DECOY_WEIGHT}, margin ${MARGIN}`,
);
for (const [set, t] of Object.entries(out)) {
  if (t.hidden + t.control === 0) continue;
  console.log(
    `${set}: hidden either ${t.either0} -> ${t.either1} of ${t.hidden} (ask cites ${t.cited0} -> ${t.cited1}); ` +
      `control ask cites decoy ${t.decoy0} -> ${t.decoy1} of ${t.control}`,
  );
}
/** A fitted model as `rank.ts` reads it, with what it was fitted on. */
const save = (file: string, train: Line[]) => {
  const model: RankModel & { fitted: Record<string, unknown> } = {
    names: NAMES,
    weights: fit(train).map((v) => Number(v.toPrecision(4))),
    fitted: {
      suites: [...new Set(train.map((l) => l.suite))],
      lambda: LAMBDA,
      decoyWeight: DECOY_WEIGHT,
      tasks: train.length,
    },
  };
  writeFileSync(file, `${JSON.stringify(model, null, 2)}\n`);
  console.log(`wrote ${file}`);
};
const OUT = opt("out", "");
if (OUT) save(OUT, lines);
const FOLDS = opt("folds", "");
if (FOLDS) {
  mkdirSync(FOLDS, { recursive: true });
  for (const held of suites)
    save(
      `${FOLDS}/${held}.json`,
      lines.filter((l) => l.suite !== held),
    );
}
