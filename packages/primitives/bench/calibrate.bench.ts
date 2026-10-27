/**
 * Calibration and thresholds: fit and predict cost, calibration quality by training-set size, and whether the
 * threshold guarantees hold (and what they cost in fires) compared with picking the threshold naively.
 *
 * Simulated data: a raw confidence score s ~ Beta(2, 5) (most events score low) and a known P(useful | s). Three
 * truths, none chosen to favour a method: logistic in s (Platt's assumption holds), convex s⁴ (not logistic), and a
 * step (0.05 below 0.7, 0.85 above). Test sets have 20,000 rows; every cell averages 20 seeds.
 */
import {
  expectedCalibrationError,
  fitPlatt,
  Isotonic,
  ISOTONIC,
  Logistic,
  logLoss,
  selectCalibrator,
  thresholdForFalseFireRate,
  thresholdForPrecision,
} from "../src/calibrate";
import { Xoshiro128 } from "../src/random";
import { binomCdf, betaInc, minTrialsToCertify, sigmoid } from "../src/stats";
import { bench, report } from "./harness";

const TRUTHS: [string, (s: number) => number][] = [
  ["logistic σ(8(s − 0.4))", (s) => sigmoid(8 * (s - 0.4))],
  ["convex min(1, 3s⁴)", (s) => Math.min(1, 3 * s ** 4)],
  ["step 0.05 | 0.85 at 0.7", (s) => (s < 0.7 ? 0.05 : 0.85)],
];

function draw(rng: Xoshiro128, n: number, truth: (s: number) => number, s: Float64Array, y: Uint8Array): void {
  for (let i = 0; i < n; i++) {
    s[i] = rng.beta(2, 5);
    y[i] = rng.uniform() < truth(s[i]!) ? 1 : 0;
  }
}

// ── Cost ──
{
  const rng = new Xoshiro128(1);
  const n = 1000;
  const s = new Float64Array(n);
  const y = new Uint8Array(n);
  draw(rng, n, TRUTHS[0]![1], s, y);
  const x8 = new Float64Array(n * 8);
  for (let i = 0; i < n * 8; i++) x8[i] = rng.normal();
  const t8 = Float64Array.from(y);
  const targets = new Float64Array(n);
  const platt = new Logistic(1);
  const lr8 = new Logistic(8);
  const iso = new Isotonic();
  fitPlatt(platt, s, y, n, targets, 100);
  iso.fit(s, y, n, 1e-3);
  const scratch = new Float64Array(n);
  const grid = new Float64Array(19).map((_, i) => 0.05 * (i + 1));
  let q = 0;
  report([
    bench("fitPlatt, n = 200", () => fitPlatt(platt, s, y, 200, targets, 100), { batch: 20 }),
    bench("fitPlatt, n = 1000", () => fitPlatt(platt, s, y, n, targets, 100), { batch: 10 }),
    bench("Logistic.fit, 8 features, n = 1000, l2 = 1", () => lr8.fit(x8, t8, n, 1, 100), { batch: 5 }),
    bench("Isotonic.fit, n = 1000", () => iso.fit(s, y, n, 1e-3), { batch: 10 }),
    bench("selectCalibrator, n = 1000, 5 folds", () => selectCalibrator(s, y, n, 5, 1e-3), { batch: 2, batches: 50 }),
    bench("Platt predict1", () => platt.predict1((q = (q + 0.001) % 1)), { batch: 1000 }),
    bench("Logistic.predict, 8 features", () => lr8.predict(x8, 8 * ((q = (q + 1) % 999) | 0)), { batch: 1000 }),
    bench("Isotonic.predict", () => iso.predict((q = (q + 0.001) % 1)), { batch: 1000 }),
    bench("thresholdForFalseFireRate, n = 1000", () => thresholdForFalseFireRate(s, y, n, 0.1, 0.1, scratch), {
      batch: 10,
    }),
    bench("thresholdForPrecision, n = 1000, 19-point grid", () => thresholdForPrecision(s, y, n, grid, 0.1, 0.1), {
      batch: 10,
    }),
  ]);
}

// ── Calibration quality by training size ──
{
  const SEEDS = 20;
  const nTest = 20_000;
  const ts = new Float64Array(nTest);
  const ty = new Uint8Array(nTest);
  const p = new Float64Array(nTest);
  const s = new Float64Array(5000);
  const y = new Uint8Array(5000);
  const targets = new Float64Array(5000);
  for (const [name, truth] of TRUTHS) {
    console.log(`── ${name}: test log loss / ECE (10 bins), mean of ${SEEDS} seeds; "chosen" = selectCalibrator`);
    console.log("   n      raw score         Platt             isotonic          chosen (isotonic picked)");
    for (const n of [50, 200, 1000, 5000]) {
      const acc = new Float64Array(8);
      let pickedIso = 0;
      for (let seed = 1; seed <= SEEDS; seed++) {
        const rng = new Xoshiro128(seed * 101 + n);
        draw(rng, n, truth, s, y);
        draw(rng, nTest, truth, ts, ty);
        const platt = new Logistic(1);
        fitPlatt(platt, s, y, n, targets, 100);
        const iso = new Isotonic();
        iso.fit(s, y, n, 1e-3);
        const choice = selectCalibrator(s, y, n, 5, 1e-3);
        if (choice.kind === ISOTONIC) pickedIso++;
        const score = (f: (v: number) => number, at: number) => {
          for (let i = 0; i < nTest; i++) p[i] = f(ts[i]!);
          acc[at]! += logLoss(p, ty, nTest, 1e-3) / SEEDS;
          acc[at + 1]! += expectedCalibrationError(p, ty, nTest, 10) / SEEDS;
        };
        score((v) => v, 0);
        score((v) => platt.predict1(v), 2);
        score((v) => iso.predict(v), 4);
        score((v) => (choice.kind === ISOTONIC ? iso.predict(v) : platt.predict1(v)), 6);
      }
      const cell = (i: number) => `${acc[i]!.toFixed(4)} / ${acc[i + 1]!.toFixed(4)}`;
      console.log(
        `   ${String(n).padEnd(6)} ${cell(0)}   ${cell(2)}   ${cell(4)}   ${cell(6)} (${pickedIso}/${SEEDS})`,
      );
    }
  }
}

// ── Threshold guarantees: false-fire rate (Neyman–Pearson order statistic) ──
{
  // Negatives' scores ~ Beta(2, 5): the true false-fire rate of threshold t is 1 − I_t(2, 5), exactly.
  const ffr = (t: number) => (t === Infinity ? 0 : 1 - betaInc(t, 2, 5));
  const trials = 2000;
  console.log(`── false-fire rate ≤ 0.1 with δ = 0.1: ${trials} calibration draws per row`);
  console.log("   negatives  method                 violations  silent   mean true FFR");
  for (const n0 of [21, 22, 50, 200, 1000]) {
    const s = new Float64Array(n0);
    const y = new Uint8Array(n0);
    const scratch = new Float64Array(n0);
    const sorted = new Float64Array(n0);
    const rows: [string, number, number, number][] = [
      ["NP order statistic", 0, 0, 0],
      ["naive 90% quantile", 0, 0, 0],
    ];
    const rng = new Xoshiro128(n0);
    for (let r = 0; r < trials; r++) {
      for (let i = 0; i < n0; i++) s[i] = rng.beta(2, 5);
      const t = thresholdForFalseFireRate(s, y, n0, 0.1, 0.1, scratch).threshold;
      sorted.set(s);
      sorted.sort();
      // Naive: let 10% of the calibration negatives sit above the threshold.
      const naive = sorted[n0 - 1 - Math.floor(0.1 * n0)]!;
      for (const [row, th] of [
        [rows[0]!, t],
        [rows[1]!, naive],
      ] as const) {
        const f = ffr(th);
        if (f > 0.1) row[1]++;
        if (th === Infinity) row[2]++;
        row[3] += f / trials;
      }
    }
    for (const [name, v, sil, f] of rows) {
      console.log(
        `   ${String(n0).padEnd(10)} ${name.padEnd(22)} ${(v / trials).toFixed(4)}      ${(sil / trials).toFixed(3)}    ${f.toFixed(4)}`,
      );
    }
  }
}

// ── Threshold guarantees: precision (Clopper–Pearson, Bonferroni over a 19-point grid) ──
{
  // s ~ Beta(2, 5), P(useful | s) = σ(8(s − 0.4)). True P(useless | s ≥ t) by numerical integration.
  const eta = TRUTHS[0]![1];
  const steps = 20_000;
  const fdr = (t: number) => {
    let mass = 0;
    let bad = 0;
    for (let i = 0; i < steps; i++) {
      const x = (i + 0.5) / steps;
      if (x < t) continue;
      const dens = 30 * x * (1 - x) ** 4; // Beta(2, 5) density
      mass += dens;
      bad += dens * (1 - eta(x));
    }
    return mass > 0 ? bad / mass : 0;
  };
  const fireRate = (t: number) => (t === Infinity ? 0 : 1 - betaInc(t, 2, 5));
  const grid = new Float64Array(19).map((_, i) => 0.05 * (i + 1));
  const gridFdr = Array.from(grid, fdr);
  const oracle = grid[gridFdr.findIndex((f) => f <= 0.1)]!;
  console.log(
    `── precision ≥ 0.9 with δ = 0.1, grid 0.05…0.95: oracle threshold ${oracle.toFixed(2)} fires on ` +
      `${fireRate(oracle).toFixed(4)} of events; 1000 draws per row`,
  );
  console.log("   n      method                        violations  silent   mean fire rate");
  for (const n of [200, 1000, 5000, 20000]) {
    const s = new Float64Array(n);
    const y = new Uint8Array(n);
    const rows: [string, number, number, number][] = [
      ["Clopper–Pearson + Bonf.", 0, 0, 0],
      ["fixed sequence (not shipped)", 0, 0, 0],
      ["naive empirical ≥ 0.9", 0, 0, 0],
    ];
    const rng = new Xoshiro128(n + 7);
    const minFired = minTrialsToCertify(0.1, 0.1);
    for (let r = 0; r < 1000; r++) {
      draw(rng, n, eta, s, y);
      const t = thresholdForPrecision(s, y, n, grid, 0.1, 0.1).threshold;
      // Naive: the lowest grid point whose empirical precision is ≥ 0.9 (with at least one fire).
      let naive = Infinity;
      for (let q = grid.length - 1; q >= 0; q--) {
        let fired = 0;
        let bad = 0;
        for (let i = 0; i < n; i++) if (s[i]! >= grid[q]!) (fired++, y[i] === 1 || bad++);
        if (fired > 0 && bad / fired <= 0.1) naive = grid[q]!;
      }
      // Fixed-sequence testing (Learn-then-Test style): from the top of the grid down, skip points with fewer fired
      // rows than can ever certify, test each at the full δ, stop at the first failure. Not shipped: the skip makes
      // the start data-dependent, which the textbook FWER argument does not cover.
      let sequential = Infinity;
      for (let q = grid.length - 1; q >= 0; q--) {
        let fired = 0;
        let bad = 0;
        for (let i = 0; i < n; i++) if (s[i]! >= grid[q]!) (fired++, y[i] === 1 || bad++);
        if (fired < minFired) continue;
        if (binomCdf(bad, fired, 0.1) > 0.1) break;
        sequential = grid[q]!;
      }
      for (const [row, th] of [
        [rows[0]!, t],
        [rows[1]!, sequential],
        [rows[2]!, naive],
      ] as const) {
        if (th !== Infinity && fdr(th) > 0.1) row[1]++;
        if (th === Infinity) row[2]++;
        row[3] += fireRate(th) / 1000;
      }
    }
    for (const [name, v, sil, f] of rows) {
      console.log(
        `   ${String(n).padEnd(6)} ${name.padEnd(29)} ${(v / 1000).toFixed(3)}       ${(sil / 1000).toFixed(3)}    ${f.toFixed(4)}`,
      );
    }
  }
}
