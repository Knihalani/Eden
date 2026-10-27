import { describe, expect, test } from "bun:test";
import {
  expectedCalibrationError,
  fires,
  fitPlatt,
  Isotonic,
  ISOTONIC,
  Logistic,
  logLoss,
  PLATT,
  selectCalibrator,
  thresholdForFalseFireRate,
  thresholdForPrecision,
} from "./calibrate";
import { Xoshiro128 } from "./random";
import { sigmoid } from "./stats";

// Two features, 12 rows, not separable. References: scikit-learn 1.9.1 LogisticRegression(C = 1/l2,
// solver="newton-cholesky", tol=1e-12), whose objective matches ours (intercept unpenalized).
const X = Float64Array.from([
  0.1, 1.2, 0.4, 0.3, 0.5, 1.9, 0.9, 0.2, 1.1, 1.4, 1.3, 0.8, 1.8, 1.1, 2.0, 0.1, 2.2, 1.7, 2.6, 0.9, 3.0, 1.3, 3.1,
  0.4,
]);
const Y = Float64Array.from([0, 0, 0, 1, 0, 1, 0, 1, 1, 1, 1, 1]);

const close = (a: ArrayLike<number>, b: ArrayLike<number>, tol: number) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(tol * Math.max(1, Math.abs(b[i]!)));
};

describe("Logistic", () => {
  test("matches scikit-learn with L2 = 1 and L2 = 0.01", () => {
    const m = new Logistic(2);
    m.fit(X, Y, 12, 1, 100);
    close(m.weights, [1.210553436335152, -0.6142128754180713, -0.8812545696914871], 1e-8);
    expect(m.iterations).toBeGreaterThan(0);
    m.fit(X, Y, 12, 0.01, 100);
    close(m.weights, [3.8415323973303326, -3.517603789698623, -1.8269129935101682], 1e-8);
  });

  test("separable data: finite with L2, flagged as not converged without", () => {
    const xs = Float64Array.from([0, 0.5, 1, 1.5, 2, 2.5]);
    const ys = Float64Array.from([0, 0, 0, 1, 1, 1]);
    const m = new Logistic(1);
    m.fit(xs, ys, 6, 1, 100);
    close(m.weights, [1.1439283858588696, -1.4299104823235869], 1e-10);
    m.fit(xs, ys, 6, 0, 30);
    expect(m.iterations).toBe(-1);
    expect(Number.isFinite(m.weights[0]!)).toBe(true);
    // Still ranks correctly and puts the boundary between the classes.
    expect(m.predict1(1)).toBeLessThan(0.5);
    expect(m.predict1(1.5)).toBeGreaterThan(0.5);
  });

  test("n = 0, a constant feature, NaN rows: no throw, no NaN weights", () => {
    const m = new Logistic(2);
    expect(m.fit(new Float64Array(0), new Float64Array(0), 0, 1, 50)).toBe(0);
    expect(m.predict(Float64Array.from([1, 1]), 0)).toBe(0.5);
    // Constant second feature with l2 = 0: the Hessian is singular; the jitter keeps the step finite.
    const xc = Float64Array.from([0, 1, 1, 1, 2, 1, 3, 1, 4, 1]);
    const yc = Float64Array.from([0, 1, 0, 1, 1]);
    m.fit(xc, yc, 5, 0, 100);
    for (const w of m.weights) expect(Number.isFinite(w)).toBe(true);
    // A NaN row is skipped: the fit equals the fit without it.
    const withNan = Float64Array.from([...X, NaN, 1]);
    const yNan = Float64Array.from([...Y, 1]);
    m.fit(withNan, yNan, 13, 1, 100);
    close(m.weights, [1.210553436335152, -0.6142128754180713, -0.8812545696914871], 1e-8);
    expect(m.predict(Float64Array.from([NaN, 0]), 0)).toBeNaN();
  });
});

describe("Platt scaling", () => {
  test("matches a direct minimization of Platt's objective (scipy BFGS, gtol 1e-12)", () => {
    const s = Float64Array.from([-2.0, -1.5, -1.0, -0.6, -0.2, 0.1, 0.3, 0.7, 1.2, 1.9, 2.4, -0.4, 0.9, 1.5]);
    const t = Uint8Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 1]);
    const m = new Logistic(1);
    fitPlatt(m, s, t, 14, new Float64Array(14), 100);
    // scipy's BFGS stops at ~2e-8 relative; our Newton converges further.
    close(m.weights, [0.9714115686734948, -0.23293704710790464], 1e-7);
  });

  test("separable scores stay finite (smoothed targets)", () => {
    const m = new Logistic(1);
    fitPlatt(m, Float64Array.from([-1, -0.5, 0.5, 1]), Uint8Array.from([0, 0, 1, 1]), 4, new Float64Array(4), 100);
    close(m.weights, [1.3479927695847855, 0], 1e-7);
  });

  test("all-same labels and tiny n give (n+1)/(n+2), not certainty", () => {
    const m = new Logistic(1);
    for (const n of [1, 2, 5, 40]) {
      const s = new Float64Array(n).map((_, i) => i * 0.3);
      fitPlatt(m, s, new Uint8Array(n).fill(1), n, new Float64Array(n), 100);
      for (let i = 0; i < n; i++) expect(Math.abs(m.predict1(s[i]!) - (n + 1) / (n + 2))).toBeLessThan(1e-6);
      fitPlatt(m, s, new Uint8Array(n), n, new Float64Array(n), 100);
      for (let i = 0; i < n; i++) expect(Math.abs(m.predict1(s[i]!) - 1 / (n + 2))).toBeLessThan(1e-6);
    }
  });
});

describe("Isotonic", () => {
  // scikit-learn 1.9.1 IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1), ties at 0.2, 0.3 and 0.5.
  const xs = Float64Array.from([0.1, 0.2, 0.2, 0.3, 0.45, 0.5, 0.5, 0.7, 0.8, 0.9, 0.3, 0.6]);
  const ys = Uint8Array.from([1, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);

  test("matches scikit-learn's thresholds and predictions", () => {
    const iso = new Isotonic();
    iso.fit(xs, ys, 12, 0);
    close(iso.xs.subarray(0, iso.size), [0.1, 0.45, 0.5, 0.7, 0.8, 0.9], 1e-15);
    close(iso.ys.subarray(0, iso.size), [1 / 3, 1 / 3, 0.75, 0.75, 1, 1], 1e-15);
    const q = [0.0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.55, 0.65, 0.75, 0.85, 1.0];
    const want = [1 / 3, 1 / 3, 1 / 3, 1 / 3, 1 / 3, 1 / 3, 1 / 3, 0.75, 0.75, 0.75, 0.875, 1, 1];
    close(
      q.map((v) => iso.predict(v)),
      want,
      1e-15,
    );
  });

  test("eps clamps the extremes; output is monotone in the score", () => {
    const iso = new Isotonic();
    iso.fit(xs, ys, 12, 0.01);
    expect(iso.predict(1)).toBe(0.99);
    const rng = new Xoshiro128(11);
    const n = 300;
    const s = new Float64Array(n);
    const y = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      s[i] = rng.uniform();
      y[i] = rng.uniform() < s[i]! ? 1 : 0;
    }
    iso.fit(s, y, n, 0);
    let prev = -1;
    for (let v = -0.1; v <= 1.1; v += 0.001) {
      const p = iso.predict(v);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  test("n = 0, 1, 2, all ties, NaN", () => {
    const iso = new Isotonic();
    expect(iso.fit(new Float64Array(0), new Uint8Array(0), 0, 0)).toBe(0);
    expect(iso.predict(0.3)).toBe(0.5);
    iso.fit(Float64Array.from([0.4]), Uint8Array.from([1]), 1, 0.05);
    expect(iso.predict(0)).toBe(0.95);
    iso.fit(Float64Array.from([0.4, 0.2]), Uint8Array.from([0, 1]), 2, 0);
    expect(iso.predict(0.3)).toBe(0.5); // violators pooled
    iso.fit(Float64Array.from([0.5, 0.5, 0.5, 0.5]), Uint8Array.from([1, 0, 0, 1]), 4, 0);
    expect(iso.predict(0.5)).toBe(0.5);
    expect(iso.predict(NaN)).toBeNaN();
    iso.fit(Float64Array.from([NaN, 0.1, 0.9]), Uint8Array.from([1, 0, 1]), 3, 0);
    expect(iso.predict(0.1)).toBe(0);
    expect(iso.predict(0.9)).toBe(1);
  });
});

describe("metrics", () => {
  test("logLoss and ECE on hand-checked values", () => {
    const p = Float64Array.from([0.9, 0.1, 0.8, 0.3]);
    const y = Uint8Array.from([1, 0, 0, 1]);
    const want = -(Math.log(0.9) + Math.log(0.9) + Math.log(0.2) + Math.log(0.3)) / 4;
    expect(Math.abs(logLoss(p, y, 4, 1e-12) - want)).toBeLessThan(1e-15);
    // Two bins: [0, .5) holds 0.1 (y 0) and 0.3 (y 1): |0.4 − 1| / 4; [.5, 1] holds 0.9 (1), 0.8 (0): |1.7 − 1| / 4.
    expect(Math.abs(expectedCalibrationError(p, y, 4, 2) - (0.6 + 0.7) / 4)).toBeLessThan(1e-15);
    expect(logLoss(Float64Array.from([0, 1]), Uint8Array.from([1, 0]), 2, 1e-3)).toBeCloseTo(-Math.log(1e-3), 12);
  });
});

/** Scores in (0, 1) with P(y = 1 | s) = truth(s). */
function sample(rng: Xoshiro128, n: number, truth: (s: number) => number, s: Float64Array, y: Uint8Array): void {
  for (let i = 0; i < n; i++) {
    s[i] = rng.uniform();
    y[i] = rng.uniform() < truth(s[i]!) ? 1 : 0;
  }
}

describe("selectCalibrator", () => {
  test("too little data: Platt, marked insufficient", () => {
    const c = selectCalibrator(Float64Array.from([0.1, 0.9, 0.5]), Uint8Array.from([0, 1, 1]), 3, 5, 1e-3);
    expect(c.kind).toBe(PLATT);
    expect(c.insufficient).toBe(true);
  });

  test("prefers Platt when the truth is logistic and data is small; isotonic for a step with plenty", () => {
    const rng = new Xoshiro128(21);
    const s = new Float64Array(5000);
    const y = new Uint8Array(5000);
    sample(rng, 150, (v) => sigmoid(6 * (v - 0.5)), s, y);
    const small = selectCalibrator(s, y, 150, 5, 1e-3);
    expect(small.kind).toBe(PLATT);
    sample(rng, 5000, (v) => (v < 0.7 ? 0.05 : 0.9), s, y);
    const step = selectCalibrator(s, y, 5000, 5, 1e-3);
    expect(step.kind).toBe(ISOTONIC);
    expect(step.isotonicEce).toBeLessThan(step.plattEce);
  });
});

describe("thresholdForFalseFireRate (Neyman–Pearson order statistic)", () => {
  test("hand example: 100 negatives at 0.00 … 0.99, alpha = delta = 0.1", () => {
    const s = new Float64Array(100).map((_, i) => i / 100);
    const t = thresholdForFalseFireRate(s, new Uint8Array(100), 100, 0.1, 0.1, new Float64Array(100));
    // P(Bin(100, .1) ≤ 5) = 0.0576 ≤ 0.1 < P(Bin(100, .1) ≤ 6): five negatives may sit above, so t = 0.94.
    expect(t.threshold).toBe(0.94);
    expect(t.errors).toBe(5);
    expect(t.achievedDelta).toBeCloseTo(0.05757688648703444, 12);
  });

  test("silent below the minimum: 21 negatives cannot certify 10% at 90%; 22 can", () => {
    const s = new Float64Array(30).map((_, i) => i / 30);
    const labels = new Uint8Array(30);
    expect(thresholdForFalseFireRate(s, labels, 21, 0.1, 0.1, new Float64Array(30)).threshold).toBe(Infinity);
    const t = thresholdForFalseFireRate(s, labels, 22, 0.1, 0.1, new Float64Array(30));
    expect(t.threshold).toBe(21 / 30); // the largest negative: fire only strictly above every one seen
    expect(thresholdForFalseFireRate(s, labels, 0, 0.1, 0.1, new Float64Array(30)).threshold).toBe(Infinity);
  });

  test("positives and NaN scores are ignored; ties fire strictly above", () => {
    const s = Float64Array.from([NaN, 0.5, 0.5, 0.5, 0.9, ...new Array(30).fill(0.5)]);
    const y = Uint8Array.from([0, 0, 0, 0, 1, ...new Array(30).fill(0)]);
    const t = thresholdForFalseFireRate(s, y, s.length, 0.1, 0.1, new Float64Array(s.length));
    expect(t.threshold).toBe(0.5);
    expect(t.support).toBe(33);
    expect(t.errors).toBe(0);
    expect(fires(t, 0.5)).toBe(false);
    expect(fires(t, 0.5000001)).toBe(true);
    expect(fires(t, NaN)).toBe(false);
  });

  test("coverage: across 2,000 calibration draws the true false-fire rate exceeds alpha in ≤ delta of them", () => {
    // Negatives' scores ~ U(0, 1), so the true false-fire rate of threshold t is exactly 1 − t.
    const rng = new Xoshiro128(31);
    const n = 200;
    const s = new Float64Array(n);
    const y = new Uint8Array(n);
    const scratch = new Float64Array(n);
    let violations = 0;
    let achieved = 0;
    const trials = 2000;
    for (let r = 0; r < trials; r++) {
      for (let i = 0; i < n; i++) s[i] = rng.uniform();
      const t = thresholdForFalseFireRate(s, y, n, 0.1, 0.1, scratch);
      achieved = t.achievedDelta;
      if (1 - t.threshold > 0.1) violations++;
    }
    // For continuous scores the violation probability is exactly the achieved delta, P(Bin(200, 0.1) ≤ 14) = 0.0929:
    // the simulated rate must agree within 3 standard errors (≈ 0.019), so the bound is valid and not loose.
    expect(achieved).toBeCloseTo(0.0929461794991082, 12);
    expect(Math.abs(violations / trials - achieved)).toBeLessThan(3 * Math.sqrt((achieved * (1 - achieved)) / trials));
  });
});

describe("thresholdForPrecision (Clopper–Pearson, Bonferroni over a fixed grid)", () => {
  const grid = new Float64Array(19).map((_, i) => 0.05 * (i + 1)); // 0.05 … 0.95

  test("silent when no grid point has enough fired rows", () => {
    const rng = new Xoshiro128(41);
    const s = new Float64Array(40);
    const y = new Uint8Array(40);
    sample(rng, 40, (v) => v, s, y);
    expect(thresholdForPrecision(s, y, 40, grid, 0.1, 0.1).threshold).toBe(Infinity);
    expect(thresholdForPrecision(s, y, 0, grid, 0.1, 0.1).threshold).toBe(Infinity);
  });

  test("all fired rows useful: certified once there are enough of them", () => {
    const s = new Float64Array(60).fill(0.9);
    const y = new Uint8Array(60).fill(1);
    const t = thresholdForPrecision(s, y, 60, grid, 0.1, 0.1);
    expect(t.threshold).toBe(0.05);
    expect(t.bound).toBeLessThanOrEqual(0.1);
    expect(t.errors).toBe(0);
    expect(fires(t, 0.05)).toBe(true);
    expect(fires(t, NaN)).toBe(false);
    const silent = thresholdForPrecision(s, y, 0, grid, 0.1, 0.1);
    expect(fires(silent, Infinity)).toBe(false);
  });

  test("coverage: precision at the chosen threshold falls below 1 − alpha in ≤ delta of 1,000 draws", () => {
    // Scores ~ U(0, 1), P(useful | s) = s, so the true P(useless | s ≥ t) = (1 − t) / 2: alpha = 0.1 needs t ≥ 0.8.
    const rng = new Xoshiro128(43);
    const n = 1500;
    const s = new Float64Array(n);
    const y = new Uint8Array(n);
    let violations = 0;
    let silent = 0;
    const trials = 1000;
    for (let r = 0; r < trials; r++) {
      sample(rng, n, (v) => v, s, y);
      const t = thresholdForPrecision(s, y, n, grid, 0.1, 0.1);
      if (t.threshold === Infinity) silent++;
      else if ((1 - t.threshold) / 2 > 0.1 + 1e-12) violations++;
    }
    expect(violations / trials).toBeLessThan(0.1);
    expect(silent).toBeLessThan(trials); // it does certify something at this n
  });
});
