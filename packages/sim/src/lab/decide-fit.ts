#!/usr/bin/env bun
/**
 * Fits a no-model decision model over the engine's per-candidate facts (`decide.ts`, docs/research/econ-decide.md)
 * from the funnel's candidate dump (`hidden-funnel.ts --candidates`), and says how it would decide on suites it was not
 * fitted on. A lab instrument for gate research: the engine does not carry the model (D67).
 *
 * Each task's slow-path decision (its last `lookup` or `served` dump) is one choice among its candidates: the planted
 * item of a hidden task is the positive; every other candidate, and the decoy of a control task above all, is a
 * negative. A logistic model with an L2 penalty is fitted by Newton's method on standardised facts (no dependency).
 *
 * The policy it is scored for: the rule paths' delivery stands, and the best candidate they did not deliver is added
 * when its probability clears the threshold. Leave-one-suite-out: each suite is decided by a model
 * fitted on the others only, and the table pools those out-of-fold decisions, so its numbers are what the model does on
 * a suite it has not seen (in-sample suites only: the blind ones are never read here).
 *
 *   bun packages/sim/src/lab/decide-fit.ts cand.jsonl [--lambda 3] [--decoy-weight 3] [--out model.json]
 *     [--folds DIR]   # each fold's model as DIR/<suite>.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { FACT_NAMES, type Facts } from "@eden/engine";

/** A logistic model: an intercept, a weight per fact (`FACT_NAMES` order), and each fact's mean and scale. */
interface DecideModel {
  intercept: number;
  weights: readonly number[];
  mean: readonly number[];
  scale: readonly number[];
}

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const FILE = args[0];
if (!FILE || FILE.startsWith("--")) throw new Error("usage: decide-fit.ts cand.jsonl [options]");
const LAMBDA = Number(opt("lambda", "3"));
const DECOY_WEIGHT = Number(opt("decoy-weight", "3"));
const BLIND = /^heldout[5-9]$/;
/** `--residual`: fit and calibrate on the candidates the rule paths left undelivered (the only ones it adds). */
const RESIDUAL = args.includes("--residual");

interface Dump {
  path: string;
  candidates: { id: string; facts: Facts }[];
  delivered: string[];
  how: string;
}
interface Line {
  suite: string;
  seed: number;
  variant: "hidden" | "control";
  template: string;
  planted: string;
  delivered: string[];
  dumps?: Dump[];
}
interface Task {
  line: Line;
  /** The slow path's decision, when the task reached it. */
  dump: Dump | null;
  xs: number[][];
  ys: number[];
}

const lines = readFileSync(FILE, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Line);
if (lines.some((l) => BLIND.test(l.suite)))
  throw new Error("a blind suite is in the dump: fit on in-sample suites only");
const tasks: Task[] = lines.map((line) => {
  const dump = [...(line.dumps ?? [])].reverse().find((d) => d.path === "lookup" || d.path === "served") ?? null;
  const cands = dump?.candidates ?? [];
  return {
    line,
    dump,
    xs: cands.map((c) => FACT_NAMES.map((k) => c.facts[k])),
    ys: cands.map((c) => (line.variant === "hidden" && c.id === line.planted ? 1 : 0)),
  };
});
const suites = [...new Set(lines.map((l) => l.suite))];
const D = FACT_NAMES.length;

/** Fits a logistic model with an L2 penalty on standardised facts by Newton's method. */
function fit(train: Task[]): DecideModel {
  const rows: { x: number[]; y: number; w: number }[] = [];
  for (const t of train) {
    t.xs.forEach((x, i) => {
      const id = t.dump!.candidates[i]!.id;
      if (RESIDUAL && t.line.delivered.includes(id)) return;
      const decoy = t.line.variant === "control" && id === t.line.planted;
      rows.push({ x, y: t.ys[i]!, w: decoy ? DECOY_WEIGHT : 1 });
    });
  }
  const mean = new Array<number>(D).fill(0);
  const scale = new Array<number>(D).fill(0);
  for (const r of rows) for (let j = 0; j < D; j++) mean[j]! += r.x[j]! / rows.length;
  for (const r of rows) for (let j = 0; j < D; j++) scale[j]! += (r.x[j]! - mean[j]!) ** 2 / rows.length;
  for (let j = 0; j < D; j++) scale[j] = Math.sqrt(scale[j]!) || 1;
  const z = rows.map((r) => [1, ...r.x.map((v, j) => (v - mean[j]!) / scale[j]!)]);
  const P = D + 1;
  let beta = new Array<number>(P).fill(0);
  for (let iter = 0; iter < 30; iter++) {
    const grad = new Array<number>(P).fill(0);
    const hess = Array.from({ length: P }, () => new Array<number>(P).fill(0));
    rows.forEach((r, i) => {
      const zi = z[i]!;
      let s = 0;
      for (let j = 0; j < P; j++) s += beta[j]! * zi[j]!;
      const p = 1 / (1 + Math.exp(-s));
      const g = r.w * (p - r.y);
      const h = r.w * p * (1 - p);
      for (let j = 0; j < P; j++) {
        grad[j]! += g * zi[j]!;
        for (let k = j; k < P; k++) hess[j]![k]! += h * zi[j]! * zi[k]!;
      }
    });
    for (let j = 0; j < P; j++) for (let k = 0; k < j; k++) hess[j]![k] = hess[k]![j]!;
    // The intercept is not penalised.
    for (let j = 1; j < P; j++) {
      grad[j]! += LAMBDA * beta[j]!;
      hess[j]![j]! += LAMBDA;
    }
    const step = solve(hess, grad);
    beta = beta.map((b, j) => b - step[j]!);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  return { intercept: beta[0]!, weights: beta.slice(1), mean, scale };
}

/** Gaussian elimination with partial pivoting (P is small). */
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
      if (f !== 0) for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / (m[i]![i]! || 1e-12));
}

const prob = (m: DecideModel, x: number[]) => {
  let s = m.intercept;
  for (let j = 0; j < D; j++) s += m.weights[j]! * ((x[j]! - m.mean[j]!) / (m.scale[j]! || 1));
  return 1 / (1 + Math.exp(-s));
};

/** Out-of-fold probabilities for every task's candidates (leave-one-suite-out). */
const oof = new Map<Task, number[]>();
const folds: Record<string, DecideModel> = {};
for (const held of suites) {
  const model = fit(tasks.filter((t) => t.line.suite !== held && t.dump));
  folds[held] = model;
  for (const t of tasks.filter((t) => t.line.suite === held))
    oof.set(
      t,
      t.xs.map((x) => prob(model, x)),
    );
}

/**
 * The policy at a threshold: the rule paths' delivery, plus the best undelivered candidate that clears it. With `gate`,
 * the fallback's pick (D36's best guess) is kept only when its probability reaches the gate.
 */
function policy(threshold: number, probs: Map<Task, number[]>, gate = -Infinity) {
  const out = { hidden: 0, nHidden: 0, decoy: 0, nControl: 0, added: 0, addedHit: 0, addedDecoy: 0 };
  const per: Record<string, { hidden: number; nHidden: number; decoy: number; nControl: number }> = {};
  for (const t of tasks) {
    const ps = probs.get(t) ?? [];
    const got = new Set(t.line.delivered);
    if (t.dump?.how === "fallback") {
      const i = t.dump.candidates.findIndex((c) => c.id === t.dump!.delivered[0]);
      if (i >= 0 && ps[i]! < gate) got.delete(t.dump.candidates[i]!.id);
    }
    let best = -1;
    for (let i = 0; i < ps.length; i++) {
      if (got.has(t.dump!.candidates[i]!.id)) continue;
      if (best < 0 || ps[i]! > ps[best]!) best = i;
    }
    if (best >= 0 && ps[best]! >= threshold) {
      const id = t.dump!.candidates[best]!.id;
      got.add(id);
      out.added++;
      if (id === t.line.planted) {
        if (t.line.variant === "hidden") out.addedHit++;
        else out.addedDecoy++;
      }
    }
    const s = (per[t.line.suite] ??= { hidden: 0, nHidden: 0, decoy: 0, nControl: 0 });
    if (t.line.variant === "hidden") {
      out.nHidden++;
      s.nHidden++;
      if (got.has(t.line.planted)) (out.hidden++, s.hidden++);
    } else {
      out.nControl++;
      s.nControl++;
      if (got.has(t.line.planted)) (out.decoy++, s.decoy++);
    }
  }
  return { ...out, per };
}

const base = policy(Infinity, oof);
console.log(
  `tasks ${tasks.length} (${suites.join(", ")}); facts ${D}; lambda ${LAMBDA}; decoy weight ${DECOY_WEIGHT}\n` +
    `rules alone: hidden ${base.hidden}/${base.nHidden}, decoys ${base.decoy}/${base.nControl}`,
);
console.log("\nleave-one-suite-out (each suite decided by a model fitted on the others):");
console.log("threshold  hidden      decoys    added/task  added hits  added decoys");
for (const th of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15, 0.1]) {
  const r = policy(th, oof);
  console.log(
    `${th.toFixed(2).padStart(9)}  ${`${r.hidden}/${r.nHidden}`.padEnd(10)}  ${`${r.decoy}/${r.nControl}`.padEnd(8)}` +
      `  ${(r.added / tasks.length).toFixed(3).padStart(10)}  ${String(r.addedHit).padStart(10)}  ${String(r.addedDecoy).padStart(12)}`,
  );
}
// "Also found": the k best undelivered candidates listed beside the packet for the agent to judge, by the model's
// out-of-fold probability or by the lexical score. Counted: the planted items the rules missed that the list holds
// (hidden), and the decoys it holds that the rules did not deliver (control).
console.log("\nalso found, k best undelivered candidates (out of fold): missed planted listed / decoys listed");
for (const k of [1, 2, 3, 5]) {
  const by = (order: "model" | "score") => {
    let hit = 0;
    let decoy = 0;
    for (const t of tasks) {
      if (!t.dump || t.line.delivered.includes(t.line.planted)) continue;
      const ps = oof.get(t) ?? [];
      const idx = t.dump.candidates
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => !t.line.delivered.includes(c.id))
        .sort((a, b) => (order === "model" ? ps[b.i]! - ps[a.i]! : b.c.facts.score - a.c.facts.score))
        .slice(0, k);
      if (idx.some(({ c }) => c.id === t.line.planted)) t.line.variant === "hidden" ? hit++ : decoy++;
    }
    return `${hit}/${base.nHidden - base.hidden} missed, ${decoy} decoys`;
  };
  console.log(`  k=${k}: model ${by("model")}; lexical score ${by("score")}`);
}
console.log("\nfallback gated by the model (out of fold), no other addition: gate, hidden, decoys");
for (const g of [0.05, 0.1, 0.2, 0.3, 0.5]) {
  const r = policy(Infinity, oof, g);
  console.log(`  ${g.toFixed(2)}: ${r.hidden}/${r.nHidden}, ${r.decoy}/${r.nControl}`);
}
const th = Number(opt("threshold", "0.5"));
const at = policy(th, oof);
console.log(`\nper suite at ${th} (out of fold):`);
for (const s of suites) {
  const r = at.per[s]!;
  const b = base.per[s]!;
  console.log(
    `${s.padEnd(10)} hidden ${b.hidden}/${b.nHidden} -> ${r.hidden}/${r.nHidden}, decoys ${b.decoy}/${b.nControl} -> ` +
      `${r.decoy}/${r.nControl}`,
  );
}

// Calibration of the out-of-fold probability of each task's best candidate (hit = it is the planted, hidden item).
const bins = [0, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1.0001];
const cal = bins.slice(1).map(() => ({ n: 0, hit: 0, p: 0 }));
for (const t of tasks) {
  const ps = oof.get(t) ?? [];
  ps.forEach((p, i) => {
    const b = bins.findIndex((lo, k) => p >= lo && p < bins[k + 1]!);
    cal[b]!.n++;
    cal[b]!.p += p;
    if (t.ys[i]) cal[b]!.hit++;
  });
}
console.log("\ncalibration, every candidate, out of fold (bin: n, mean p, share planted):");
cal.forEach((c, k) =>
  console.log(
    `  [${bins[k]!.toFixed(1)}, ${Math.min(1, bins[k + 1]!).toFixed(1)}): ${String(c.n).padStart(6)}  ` +
      `${(c.p / Math.max(1, c.n)).toFixed(3)}  ${(c.hit / Math.max(1, c.n)).toFixed(3)}`,
  ),
);

const all = fit(tasks.filter((t) => t.dump));
console.log("\nweights (standardised), fitted on every in-sample suite:");
FACT_NAMES.map((k, j) => [k, all.weights[j]!] as const)
  .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
  .forEach(([k, w]) => console.log(`  ${k.padEnd(14)} ${w.toFixed(3)}`));
const round = (xs: readonly number[]) => xs.map((v) => Number(v.toFixed(4)));
const json = {
  intercept: Number(all.intercept.toFixed(4)),
  weights: round(all.weights),
  mean: round(all.mean),
  scale: round(all.scale),
};
const out = opt("out", "");
if (out) writeFileSync(out, `${JSON.stringify(json)}\n`);
const dir = opt("folds", "");
if (dir) {
  for (const [s, m] of Object.entries(folds)) {
    writeFileSync(
      `${dir}/${s}.json`,
      JSON.stringify({ ...m, weights: round(m.weights), mean: round(m.mean), scale: round(m.scale) }),
    );
  }
}
