#!/usr/bin/env bun
/**
 * Fits the distilled reader (distilled-reader.ts; docs/research/distilled-reader.md) on recorded reader calls, with
 * leave-one-suite-out cross-validation over the train suites, and writes the model (all train data, plus one model per
 * left-out suite for cross-validated funnel screens).
 *
 *   bun packages/sim/src/lab/distilled-fit.ts --records R.jsonl[,R2.jsonl] --out model.json [--labels-out L.jsonl]
 *     [--max-loss 0.01] [--silent-cut X] [--bind-precision 0.95] [--trees 150] [--depth 3]
 *
 * Labels: a (request, candidate) pair is positive when the reader named the candidate as binding (`bears`). Calls with
 * no readable answer are left out. The thresholds are chosen on the out-of-fold scores only:
 * - `silent`: the largest cut at which the hidden tasks lost number at most `--max-loss` of the hidden tasks that had a
 *   reader call (lost: the reader flagged the planted item and every call that flagged it is decided silent). The
 *   denominator is every hidden task with a call, as the frozen blind model was fitted (D104); `--silent-cut X` sets
 *   the cut instead (the note's 1.5x row);
 * - `bind`: the smallest cut at which a local bind agrees with the reader at `--bind-precision` or better (off when no
 *   cut reaches it on at least 20 calls).
 * `--labels-out` writes the committed labels file: per call its task, `readerKey`, pool size, planted item and verdict
 * (no item text), which `--distill labels:FILE` replays at $0 to rebuild the records.
 * The thresholds come from the fold models' out-of-fold scores and are applied to the model fitted on all of train,
 * whose scores may be calibrated a little differently.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  decide,
  FEATURE_NAMES,
  poolFeatures,
  type DistilledModel,
  type LabelRow,
  type RecordedCall,
  type Tree,
} from "./distilled-reader";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const RECORDS = opt("records", "").split(",").filter(Boolean);
const OUT = opt("out", "");
const LABELS_OUT = opt("labels-out", "");
const MAX_LOSS = Number(opt("max-loss", "0.01"));
/** A fixed silent cut in place of the one `--max-loss` chooses (NaN: choose). */
const SILENT_CUT = Number(opt("silent-cut", "NaN"));
const BIND_PRECISION = Number(opt("bind-precision", "0.95"));
const TREES = Number(opt("trees", "150"));
const DEPTH = Number(opt("depth", "3"));
const RATE = 0.1;
const MIN_LEAF = 20;
if (!RECORDS.length) throw new Error("--records is required");

// ---- data ------------------------------------------------------------------------------------------------------
const calls: RecordedCall[] = [];
const seen = new Set<string>();
for (const f of RECORDS) {
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const c = JSON.parse(line) as RecordedCall;
    // A request read twice with the same pool (the push's read and the ask's) is one call to the model.
    const k = `${c.task}\n${c.key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    calls.push(c);
  }
}
const readable = calls.filter((c) => c.bears !== null);
const suiteOf = (c: RecordedCall) => c.task.split("/")[0]!;
const suites = [...new Set(readable.map(suiteOf))].sort();

if (LABELS_OUT) {
  const rows: LabelRow[] = calls.map((c) => ({
    task: c.task,
    key: c.key,
    n: c.items.length,
    planted: { ...c.planted, at: c.items.findIndex((it) => it.id === c.planted.id) },
    bears: c.bears,
    rejected: c.rejected,
  }));
  writeFileSync(LABELS_OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

interface Pair {
  call: number;
  x: number[];
  y: number;
}
const pairs: Pair[] = [];
const featuresOf = new Map<number, number[][]>();
readable.forEach((c, ci) => {
  const xs = poolFeatures({ request: c.request, question: c.question, items: c.items, today: c.today });
  featuresOf.set(ci, xs);
  const bound = new Set(c.bears!.map((b) => b.i));
  xs.forEach((x, i) => pairs.push({ call: ci, x, y: bound.has(i) ? 1 : 0 }));
});

// ---- boosted trees (logistic loss) -----------------------------------------------------------------------------
/** Candidate split points per feature: up to 31 distinct quantiles of the training rows. */
function cutsOf(rows: Pair[]): number[][] {
  return FEATURE_NAMES.map((_, f) => {
    const vals = [...new Set(rows.map((r) => r.x[f]!))].sort((a, b) => a - b);
    if (vals.length <= 32) return vals.slice(0, -1).map((v, i) => (v + vals[i + 1]!) / 2);
    return Array.from({ length: 31 }, (_, q) => vals[Math.floor(((q + 1) * vals.length) / 32)]!);
  });
}

/**
 * One tree, grown on histograms: each row's feature values are binned once (`bins[f][r]`, the index of the first cut
 * at or above the value), so a node scores every split of a feature in one pass over its rows.
 */
function grow(rows: number[], bins: Uint8Array[], g: number[], h: number[], cuts: number[][], depth: number): Tree {
  let G = 0;
  let H = 0;
  for (const r of rows) {
    G += g[r]!;
    H += h[r]!;
  }
  const value = { v: (RATE * G) / (H + 1) };
  if (depth === 0 || rows.length < 2 * MIN_LEAF) return value;
  let best = { gain: 0, f: -1, b: 0 };
  const base = (G * G) / (H + 1);
  for (let f = 0; f < cuts.length; f++) {
    const k = cuts[f]!.length;
    if (k === 0) continue;
    const gs = new Float64Array(k + 1);
    const hs = new Float64Array(k + 1);
    const ns = new Int32Array(k + 1);
    const bf = bins[f]!;
    for (const r of rows) {
      const b = bf[r]!;
      gs[b] = gs[b]! + g[r]!;
      hs[b] = hs[b]! + h[r]!;
      ns[b] = ns[b]! + 1;
    }
    let gl = 0;
    let hl = 0;
    let nl = 0;
    // Split "value <= cuts[f][b]": bins 0..b go left.
    for (let b = 0; b < k; b++) {
      gl += gs[b]!;
      hl += hs[b]!;
      nl += ns[b]!;
      if (nl < MIN_LEAF || rows.length - nl < MIN_LEAF) continue;
      const gain = (gl * gl) / (hl + 1) + ((G - gl) * (G - gl)) / (H - hl + 1) - base;
      if (gain > best.gain) best = { gain, f, b };
    }
  }
  if (best.f < 0) return value;
  const bf = bins[best.f]!;
  const l = rows.filter((r) => bf[r]! <= best.b);
  const r = rows.filter((r) => bf[r]! > best.b);
  return {
    f: best.f,
    t: cuts[best.f]![best.b]!,
    l: grow(l, bins, g, h, cuts, depth - 1),
    r: grow(r, bins, g, h, cuts, depth - 1),
  };
}

/** The bin of a value: the first cut it is at or below (`cuts.length` when above every cut). */
function binOf(cuts: number[], v: number): number {
  let b = 0;
  while (b < cuts.length && v > cuts[b]!) b++;
  return b;
}

const leaf = (t: Tree, x: number[]): number => ("v" in t ? t.v : leaf(x[t.f]! <= t.t ? t.l : t.r, x));

function fit(rows: Pair[]): { base: number; trees: Tree[] } {
  const pos = rows.reduce((a, r) => a + r.y, 0);
  const p0 = Math.min(0.99, Math.max(0.01, pos / rows.length));
  const base = Math.log(p0 / (1 - p0));
  const z = rows.map(() => base);
  const cuts = cutsOf(rows);
  const bins = cuts.map((c, f) => Uint8Array.from(rows, (r) => binOf(c, r.x[f]!)));
  const all = rows.map((_, i) => i);
  const trees: Tree[] = [];
  for (let k = 0; k < TREES; k++) {
    const g: number[] = [];
    const h: number[] = [];
    rows.forEach((r, i) => {
      const p = 1 / (1 + Math.exp(-z[i]!));
      g.push(r.y - p);
      h.push(p * (1 - p));
    });
    const t = grow(all, bins, g, h, cuts, DEPTH);
    trees.push(t);
    rows.forEach((r, i) => (z[i] = z[i]! + leaf(t, r.x)));
  }
  return { base, trees };
}

const prob = (m: { base: number; trees: Tree[] }, x: number[]) => {
  let z = m.base;
  for (const t of m.trees) z += leaf(t, x);
  return 1 / (1 + Math.exp(-z));
};

function auc(scores: number[], ys: number[]): number {
  const idx = scores.map((s, i) => [s, ys[i]!] as const).sort((a, b) => a[0] - b[0]);
  let rank = 0;
  let sumPos = 0;
  let nPos = 0;
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j < idx.length && idx[j]![0] === idx[i]![0]) j++;
    const avg = (i + j + 1) / 2;
    for (let k = i; k < j; k++) {
      if (idx[k]![1]) {
        sumPos += avg;
        nPos++;
      }
    }
    rank = j;
    i = j;
  }
  const nNeg = rank - nPos;
  return nPos && nNeg ? (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg) : NaN;
}

// ---- leave-one-suite-out cross-validation ----------------------------------------------------------------------
const folds: Record<string, { base: number; trees: Tree[] }> = {};
const oof = new Map<number, number[]>();
for (const s of suites) {
  const train = pairs.filter((p) => suiteOf(readable[p.call]!) !== s);
  const m = fit(train);
  folds[s] = m;
  readable.forEach((c, ci) => {
    if (suiteOf(c) === s)
      oof.set(
        ci,
        featuresOf.get(ci)!.map((x) => prob(m, x)),
      );
  });
  const test = pairs.filter((p) => suiteOf(readable[p.call]!) === s);
  console.log(
    `fold ${s}: ${train.length} train pairs, ${test.length} test pairs, AUC ` +
      `${auc(
        test.map((p) => oof.get(p.call)![featuresOf.get(p.call)!.indexOf(p.x)]!),
        test.map((p) => p.y),
      ).toFixed(3)}`,
  );
}
const allScores = pairs.map((p) => oof.get(p.call)![featuresOf.get(p.call)!.indexOf(p.x)]!);
console.log(
  `pairs ${pairs.length} (${pairs.filter((p) => p.y).length} binding) over ${readable.length} readable calls ` +
    `(${calls.length - readable.length} unreadable); out-of-fold AUC ${auc(
      allScores,
      pairs.map((p) => p.y),
    ).toFixed(3)}`,
);

// The planted item's out-of-fold score against the decoy's, on calls whose pool holds it: the relational question.
{
  const hs: number[] = [];
  const ys: number[] = [];
  readable.forEach((c, ci) => {
    const i = c.items.findIndex((it) => it.id === c.planted.id);
    if (i < 0) return;
    hs.push(oof.get(ci)![i]!);
    ys.push(c.planted.role === "hidden" ? 1 : 0);
  });
  console.log(`planted hidden vs planted decoy, out-of-fold AUC ${auc(hs, ys).toFixed(3)} over ${hs.length} calls`);
}

/** The hidden tasks whose planted item the reader flagged, and the calls that flagged it. */
const flaggedBy = new Map<string, number[]>();
readable.forEach((c, ci) => {
  if (c.planted.role !== "hidden") return;
  const i = c.items.findIndex((it) => it.id === c.planted.id);
  if (i >= 0 && c.bears!.some((b) => b.i === i)) flaggedBy.set(c.task, [...(flaggedBy.get(c.task) ?? []), ci]);
});
const hiddenTasks = new Set(readable.filter((c) => c.planted.role === "hidden").map((c) => c.task)).size;

function sweepSilent(cut: number) {
  const silent = new Set<number>();
  readable.forEach((_, ci) => {
    if (Math.max(0, ...oof.get(ci)!) < cut) silent.add(ci);
  });
  let lost = 0;
  for (const cis of flaggedBy.values()) if (cis.every((ci) => silent.has(ci))) lost++;
  const anyBind = [...silent].filter((ci) => readable[ci]!.bears!.length > 0).length;
  return { silent: silent.size, lost, anyBind };
}

console.log(`hidden tasks with a reader call: ${hiddenTasks}; planted item flagged in ${flaggedBy.size}`);
console.log("silent cut | calls decided silent | of which the reader bound something | flagged hidden tasks lost");
const grid = Array.from({ length: 60 }, (_, k) => 0.005 * 1.08 ** k).filter((x) => x < 0.9);
let silentCut = 0;
for (const cut of grid) {
  const r = sweepSilent(cut);
  if (r.lost <= MAX_LOSS * hiddenTasks) silentCut = cut;
  console.log(
    `${cut.toFixed(4)} | ${r.silent} (${((100 * r.silent) / readable.length).toFixed(1)}%) | ${r.anyBind} | ${r.lost}`,
  );
}

if (Number.isFinite(SILENT_CUT)) silentCut = SILENT_CUT;

// Local binds: among calls not decided silent, those with exactly one candidate above the silent cut and the top at
// or above `bind`; precision is agreement with the reader's own binding set.
let bindCut: number | null = null;
console.log("bind cut | local binds | agree with the reader | on the planted decoy");
for (const cut of [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.97, 0.99]) {
  let n = 0;
  let ok = 0;
  let decoy = 0;
  readable.forEach((c, ci) => {
    const local = decide(
      { version: 1, features: FEATURE_NAMES, base: 0, trees: [], silent: silentCut, bind: cut },
      oof.get(ci)!,
    );
    if (!local || !local.bears!.length) return;
    n++;
    const i = local.bears![0]!.i;
    if (c.bears!.some((b) => b.i === i)) ok++;
    if (c.planted.role === "decoy" && c.items[i]!.id === c.planted.id) decoy++;
  });
  console.log(`${cut} | ${n} | ${ok} (${n ? ((100 * ok) / n).toFixed(1) : "-"}%) | ${decoy}`);
  if (bindCut === null && n >= 20 && ok / n >= BIND_PRECISION) bindCut = cut;
}

{
  let silent = 0;
  let bind = 0;
  readable.forEach((_, ci) => {
    const d = decide(
      { version: 1, features: FEATURE_NAMES, base: 0, trees: [], silent: silentCut, bind: bindCut },
      oof.get(ci)!,
    );
    if (d && d.bears!.length) bind++;
    else if (d) silent++;
  });
  const esc = readable.length - silent - bind;
  console.log(
    `chosen: silent ${silentCut.toFixed(4)}, bind ${bindCut ?? "off"}; out-of-fold: ${silent} silent, ${bind} bind, ` +
      `${esc} escalated of ${readable.length} calls (escalation ${((100 * esc) / readable.length).toFixed(1)}%, ` +
      `${(readable.length / Math.max(1, esc)).toFixed(2)}x fewer reader calls)`,
  );
}

if (OUT) {
  const full = fit(pairs);
  const model: DistilledModel = {
    version: 1,
    features: FEATURE_NAMES,
    ...full,
    silent: silentCut,
    bind: bindCut,
    folds: Object.fromEntries(
      Object.entries(folds).map(([s, m]) => [
        s,
        { version: 1, features: FEATURE_NAMES, ...m, silent: silentCut, bind: bindCut },
      ]),
    ),
  };
  writeFileSync(OUT, JSON.stringify(model));
  console.log(`wrote ${OUT}`);
}
