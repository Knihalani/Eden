import { describe, expect, test } from "bun:test";
import {
  betaInc,
  betaIncInv,
  binomCdf,
  clopperPearsonLower,
  clopperPearsonUpper,
  log1pExp,
  logGamma,
  minTrialsToCertify,
  sigmoid,
} from "./stats";

// Reference values printed by scipy 1.18.1 (special.betainc, special.betaincinv, special.gammaln, stats.beta.ppf,
// stats.binom.cdf); the script is described in docs/research/primitives-decision.md.
const BETAINC: [number, number, number, number][] = [
  [0.5, 0.5, 0.3, 0.36901011956554536],
  [1, 1, 0.42, 0.42],
  [2, 3, 0.4, 0.5247999999999999],
  [10, 20, 0.33, 0.5019142489967602],
  [0.1, 10, 0.001, 0.6596666602208251],
  [50, 50, 0.5, 0.5000000000000007],
  [100, 3, 0.97, 0.40633618022259166],
  [1000, 2000, 0.34, 0.7812150911606441],
  [0.3, 0.05, 0.9, 0.2180864722179496],
  [5, 1, 1e-4, 1.0000000000000002e-20],
];
const BETAINCINV: [number, number, number, number][] = [
  [1, 20, 0.9, 0.10874906186625448],
  [3, 18, 0.95, 0.28261852488586087],
  [11, 190, 0.9, 0.07598978817347084],
  [1, 1000, 0.999999, 0.013720514368761167],
  [0.5, 0.5, 0.01, 0.00024671981713422146],
  [200, 2, 0.5, 0.9916640894770359],
  [2, 3, 1e-10, 4.082494015808333e-6],
  [30, 70, 0.999, 0.4498912610865279],
];
const GAMMALN: [number, number][] = [
  [0.001, 6.907178885383853],
  [0.5, 0.5723649429247],
  [1, 0],
  [1.5, -0.12078223763524526],
  [7.3, 7.147892523022249],
  [30, 71.257038967168],
  [171.5, 709.1431630309283],
  [1e5, 1051287.7089736569],
];
// [k, n, delta, bound]
const CP_UPPER: [number, number, number, number][] = [
  [0, 22, 0.1, 0.09937197978872149],
  [0, 10, 0.05, 0.2588655508930522],
  [3, 50, 0.1, 0.1287564225866019],
  [12, 200, 0.1, 0.08761788029993338],
  [19, 200, 0.05, 0.13627776482107667],
  [0, 1, 0.1, 0.9],
  [99, 100, 0.1, 0.9989469496904544],
  [500, 1000, 1e-6, 0.5752094927452731],
];
const CP_LOWER: [number, number, number, number][] = [
  [1, 22, 0.1, 0.004777664824947516],
  [5, 10, 0.05, 0.2224411010081294],
  [188, 200, 0.1, 0.9123821197000667],
  [1000, 1000, 0.05, 0.9970087504549047],
];
// [k, n, p, P(X ≤ k)]
const BINOM: [number, number, number, number][] = [
  [0, 22, 0.1, 0.0984770902183611],
  [3, 50, 0.1, 0.250293905953308],
  [12, 200, 0.1, 0.0320465287969066],
  [5, 10, 0.5, 0.623046875],
  [0, 1000, 0.001, 0.36769542477096406],
  [950, 1000, 0.97, 0.0004207665452482011],
];

const relErr = (a: number, b: number) => (b === 0 ? Math.abs(a) : Math.abs(a - b) / Math.abs(b));

describe("stats: scipy reference values", () => {
  test("betaInc", () => {
    for (const [a, b, x, v] of BETAINC) expect(relErr(betaInc(x, a, b), v)).toBeLessThan(1e-12);
  });
  test("betaIncInv", () => {
    // p near 1 is ill-conditioned in x (dI/dx is tiny there): 1e-11 relative.
    for (const [a, b, p, v] of BETAINCINV) expect(relErr(betaIncInv(p, a, b), v)).toBeLessThan(1e-11);
  });
  test("logGamma", () => {
    for (const [x, v] of GAMMALN) expect(Math.abs(logGamma(x) - v)).toBeLessThan(1e-13 * Math.max(1, Math.abs(v)));
  });
  test("Clopper–Pearson bounds", () => {
    for (const [k, n, d, v] of CP_UPPER) expect(relErr(clopperPearsonUpper(k, n, d), v)).toBeLessThan(1e-11);
    for (const [k, n, d, v] of CP_LOWER) expect(relErr(clopperPearsonLower(k, n, d), v)).toBeLessThan(1e-11);
  });
  test("binomCdf", () => {
    for (const [k, n, p, v] of BINOM) expect(relErr(binomCdf(k, n, p), v)).toBeLessThan(1e-11);
  });
});

describe("stats: identities and edges", () => {
  test("betaIncInv inverts betaInc across shapes", () => {
    for (const [a, b] of [
      [0.2, 0.2],
      [0.5, 3],
      [1, 1],
      [4, 0.7],
      [20, 80],
      [300, 5],
    ] as const) {
      for (let x = 0.01; x < 1; x += 0.07) {
        const p = betaInc(x, a, b);
        if (p < 1e-300 || p > 1 - 1e-12) continue;
        // Backward error everywhere; forward error where the CDF is not flat (near p = 1 a 1e-16 change in p moves x
        // by 1e-16 / pdf, which no inverse can avoid).
        expect(Math.abs(betaInc(betaIncInv(p, a, b), a, b) - p)).toBeLessThan(1e-14 + 1e-12 * p);
        if (p > 1e-6 && p < 1 - 1e-6) expect(relErr(betaIncInv(p, a, b), x)).toBeLessThan(1e-9);
      }
    }
  });

  test("binomCdf equals the direct sum of the pmf", () => {
    const n = 30;
    for (const p of [0.01, 0.1, 0.5, 0.93]) {
      let sum = 0;
      let c = 1; // C(n, k)
      for (let k = 0; k <= n; k++) {
        if (k > 0) c = (c * (n - k + 1)) / k;
        sum += c * p ** k * (1 - p) ** (n - k);
        expect(Math.abs(binomCdf(k, n, p) - Math.min(1, sum))).toBeLessThan(1e-12);
      }
    }
  });

  test("bounds at the edges: no data, all events, none", () => {
    expect(clopperPearsonUpper(0, 0, 0.1)).toBe(1);
    expect(clopperPearsonUpper(5, 5, 0.1)).toBe(1);
    expect(clopperPearsonLower(0, 5, 0.1)).toBe(0);
    // k = 0: the bound is 1 − δ^(1/n) in closed form.
    expect(relErr(clopperPearsonUpper(0, 37, 0.05), 1 - 0.05 ** (1 / 37))).toBeLessThan(1e-12);
    expect(binomCdf(-1, 10, 0.3)).toBe(0);
    expect(binomCdf(10, 10, 0.3)).toBe(1);
    expect(binomCdf(3, 10, 0)).toBe(1);
    expect(binomCdf(3, 10, 1)).toBe(0);
  });

  test("NaN and out-of-domain inputs give NaN, never a confident number", () => {
    expect(betaInc(NaN, 1, 1)).toBeNaN();
    expect(betaInc(0.5, 0, 1)).toBeNaN();
    expect(betaIncInv(NaN, 2, 2)).toBeNaN();
    expect(logGamma(0)).toBeNaN();
    expect(logGamma(-1)).toBeNaN();
  });

  test("minTrialsToCertify is the smallest clean n whose Clopper–Pearson bound meets alpha", () => {
    for (const [alpha, delta] of [
      [0.1, 0.1],
      [0.1, 0.05],
      [0.05, 0.1],
      [0.2, 0.01],
    ] as const) {
      const n = minTrialsToCertify(alpha, delta);
      expect(clopperPearsonUpper(0, n, delta)).toBeLessThanOrEqual(alpha);
      expect(clopperPearsonUpper(0, n - 1, delta)).toBeGreaterThan(alpha);
    }
    expect(minTrialsToCertify(0.1, 0.1)).toBe(22);
  });

  test("sigmoid and log1pExp are stable at the extremes", () => {
    expect(sigmoid(800)).toBe(1);
    expect(sigmoid(-800)).toBe(0);
    expect(sigmoid(0)).toBe(0.5);
    expect(log1pExp(800)).toBe(800);
    expect(log1pExp(-800)).toBe(0);
    expect(relErr(log1pExp(1e-10), Math.log(2) + 5e-11)).toBeLessThan(1e-15);
    expect(relErr(log1pExp(-40), Math.exp(-40))).toBeLessThan(1e-15);
  });
});
