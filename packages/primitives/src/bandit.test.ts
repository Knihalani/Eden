import { describe, expect, test } from "bun:test";
import { BetaBandit, ipsValue } from "./bandit";
import { Xoshiro128 } from "./random";
import { betaInc, logBeta } from "./stats";

const prior = (arms: number, mean: number) => new Float64Array(arms).fill(mean);

describe("BetaBandit state", () => {
  test("prior from a population mean and strength; NaN and extreme means are clamped", () => {
    const b = new BetaBandit(3, Float64Array.from([0.25, NaN, 1]), 4, 0.99, 2);
    expect([b.alpha[0], b.beta[0]]).toEqual([1, 3]);
    expect(b.mean(0)).toBe(0.25);
    expect(b.mean(1)).toBeCloseTo(0.001, 12);
    expect(b.mean(2)).toBeCloseTo(0.999, 12);
  });

  test("update adds evidence; out-of-range rewards and arms are ignored", () => {
    const b = new BetaBandit(2, prior(2, 0.5), 2, 1, 1);
    b.update(0, 1);
    b.update(0, 0.25);
    b.update(0, NaN);
    b.update(0, 2);
    b.update(5, 1);
    expect([b.alpha[0], b.beta[0]]).toEqual([2.25, 1.75]);
  });

  test("decay pulls evidence toward the prior by γ^steps and never below it", () => {
    const b = new BetaBandit(1, prior(1, 0.2), 5, 0.9, 1); // prior Beta(1, 4)
    for (let i = 0; i < 10; i++) b.update(0, 1);
    b.decay(1);
    expect(b.alpha[0]).toBeCloseTo(1 + 10 * 0.9, 12);
    expect(b.beta[0]).toBeCloseTo(4, 12);
    b.decay(2.5); // fractional steps: decay by elapsed time
    expect(b.alpha[0]).toBeCloseTo(1 + 9 * 0.9 ** 2.5, 12);
    b.decay(10_000);
    expect(b.alpha[0]).toBeCloseTo(1, 12);
    expect(b.beta[0]).toBeCloseTo(4, 12);
    b.gamma = 1;
    b.update(0, 1);
    b.decay(100);
    expect(b.alpha[0]).toBeCloseTo(2, 12);
  });

  test("decayArm discounts only that arm; out-of-range arms are ignored", () => {
    const b = new BetaBandit(2, prior(2, 0.5), 2, 0.5, 1); // prior Beta(1, 1)
    for (let i = 0; i < 4; i++) {
      b.update(0, 1);
      b.update(1, 0);
    }
    b.decayArm(0, 1);
    b.decayArm(7, 1);
    b.decayArm(-1, 1);
    expect([b.alpha[0], b.beta[0]]).toEqual([3, 1]);
    expect([b.alpha[1], b.beta[1]]).toEqual([1, 5]);
  });
});

describe("BetaBandit.select", () => {
  test("returns k distinct eligible arms, deterministically for a seed", () => {
    const b = new BetaBandit(30, prior(30, 0.3), 4, 0.99, 3);
    const eligible = new Uint8Array(30).fill(1);
    eligible[4] = 0;
    eligible[7] = 0;
    const out = new Int32Array(3);
    const r1 = new Xoshiro128(5);
    const r2 = new Xoshiro128(5);
    const out2 = new Int32Array(3);
    for (let t = 0; t < 2000; t++) {
      expect(b.select(r1, 3, eligible, null, 0.05, out)).toBe(3);
      b.select(r2, 3, eligible, null, 0.05, out2);
      expect(out2).toEqual(out);
      expect(new Set(out).size).toBe(3);
      for (const a of out) expect(eligible[a]).toBe(1);
    }
  });

  test("fewer eligible arms than k; k = 0; scale zero ties go to the lowest index", () => {
    const b = new BetaBandit(5, prior(5, 0.5), 2, 1, 3);
    const rng = new Xoshiro128(1);
    const out = new Int32Array(3);
    expect(b.select(rng, 3, Uint8Array.from([0, 1, 0, 0, 0]), null, 0, out)).toBe(1);
    expect(out[0]).toBe(1);
    expect(b.select(rng, 0, null, null, 0, out)).toBe(0);
    expect(b.select(rng, 2, null, new Float64Array(5), 0, out)).toBe(2);
    expect([out[0], out[1]]).toEqual([0, 1]);
  });

  test("concentrates on the best arms once evidence is strong", () => {
    const b = new BetaBandit(10, prior(10, 0.3), 4, 1, 2);
    for (let i = 0; i < 200; i++) {
      for (let a = 0; a < 10; a++) b.update(a, a >= 8 ? (i % 10 < 8 ? 1 : 0) : i % 10 < 2 ? 1 : 0);
    }
    const rng = new Xoshiro128(3);
    const out = new Int32Array(2);
    let hits = 0;
    for (let t = 0; t < 1000; t++) {
      b.select(rng, 2, null, null, 0, out);
      if (out[0]! >= 8 && out[1]! >= 8) hits++;
    }
    expect(hits).toBeGreaterThan(990);
  });
});

describe("propensities", () => {
  test("Monte Carlo inclusion probability matches the exact P(θ₁ > θ₂) for two arms, k = 1", () => {
    // Arm 0 ~ Beta(3, 5), arm 1 ~ Beta(4, 4): P(θ₀ > θ₁) = ∫ f₀(x) F₁(x) dx, by Simpson's rule.
    const b = new BetaBandit(2, prior(2, 0.5), 2, 1, 1);
    b.alpha[0] = 3;
    b.beta[0] = 5;
    b.alpha[1] = 4;
    b.beta[1] = 4;
    const steps = 4000;
    const lb = logBeta(3, 5);
    let exact = 0;
    for (let i = 0; i <= steps; i++) {
      const x = i / steps;
      const f = x === 0 || x === 1 ? 0 : Math.exp(2 * Math.log(x) + 4 * Math.log1p(-x) - lb);
      const w = i === 0 || i === steps ? 1 : i % 2 === 1 ? 4 : 2;
      exact += w * f * betaInc(x, 4, 4);
    }
    exact /= 3 * steps;
    const out = new Float64Array(2);
    const draws = 40_000;
    b.inclusionPropensity(new Xoshiro128(9), 1, null, null, 0, draws, out);
    const se = Math.sqrt((exact * (1 - exact)) / draws);
    expect(Math.abs(out[0]! - exact)).toBeLessThan(4 * se);
    expect(out[0]! + out[1]!).toBeCloseTo(1, 12);
    // With an ε floor, every eligible arm's propensity is at least ε·k / eligible.
    b.alpha[1] = 400;
    b.beta[1] = 1;
    b.inclusionPropensity(new Xoshiro128(9), 1, null, null, 0.1, 2000, out);
    expect(out[0]!).toBeGreaterThanOrEqual(0.1 * 0.5);
  });

  test("propensities sum to k and are 0 for ineligible arms", () => {
    const b = new BetaBandit(8, prior(8, 0.4), 4, 1, 3);
    const eligible = Uint8Array.from([1, 1, 0, 1, 1, 1, 0, 1]);
    const out = new Float64Array(8);
    b.inclusionPropensity(new Xoshiro128(2), 3, eligible, null, 0.05, 500, out);
    expect(out[2]).toBe(0);
    expect(out[6]).toBe(0);
    expect(out.reduce((s, x) => s + x, 0)).toBeCloseTo(3, 10);
  });

  test("IPS over logged propensities recovers another policy's value (stationary simulation)", () => {
    // 12 sources with fixed usefulness; log 3 picks per decision with TS + 5% uniform; evaluate the uniform policy.
    const arms = 12;
    const k = 3;
    const rng = new Xoshiro128(17);
    const prop = new Xoshiro128(18);
    const p = new Float64Array(arms);
    for (let i = 0; i < arms; i++) p[i] = rng.beta(1, 3);
    const b = new BetaBandit(arms, prior(arms, 0.25), 4, 1, k);
    const decisions = 4000;
    const rewards = new Float64Array(decisions * k);
    const logged = new Float64Array(decisions * k);
    const target = new Float64Array(decisions * k).fill(k / arms);
    const out = new Int32Array(k);
    const pi = new Float64Array(arms);
    let e = 0;
    for (let t = 0; t < decisions; t++) {
      b.inclusionPropensity(prop, k, null, null, 0.05, 200, pi);
      const got = b.select(rng, k, null, null, 0.05, out);
      for (let j = 0; j < got; j++) {
        const a = out[j]!;
        const r = rng.uniform() < p[a]! ? 1 : 0;
        rewards[e] = r;
        logged[e++] = pi[a]!;
        b.update(a, r);
      }
    }
    const truth = (k / arms) * p.reduce((s, x) => s + x, 0);
    const est = ipsValue(rewards, logged, target, e, decisions);
    // The logging policy concentrates on the best arms, so the uniform policy is evaluated far from the data:
    // within 15% relative is what IPS with a 5% floor can deliver at 4,000 decisions.
    expect(Math.abs(est - truth) / truth).toBeLessThan(0.15);
    expect(ipsValue(rewards, logged, target, 0, 0)).toBeNaN();
  });
});

describe("regret under drift (fixed seeds; a sanity check, the measured tables are in bench/bandit.bench.ts)", () => {
  test("discounted Thompson sampling beats uniform choice and greedy-by-mean when usefulness shifts", () => {
    const arms = 12;
    const k = 3;
    const T = 6000;
    const regret = (policy: "uniform" | "greedy" | "ts", seed: number) => {
      const env = new Xoshiro128(seed);
      const rng = new Xoshiro128(seed + 1000);
      const p = new Float64Array(arms);
      for (let i = 0; i < arms; i++) p[i] = env.beta(1, 3);
      const b = new BetaBandit(arms, prior(arms, 0.25), 4, policy === "ts" ? 0.99 : 1, k);
      const out = new Int32Array(k);
      const sorted = new Float64Array(arms);
      let total = 0;
      for (let t = 0; t < T; t++) {
        if (t > 0 && t % 1500 === 0) for (let i = 0; i < arms; i++) p[i] = env.beta(1, 3); // abrupt change
        let got: number;
        if (policy === "uniform") got = b.select(rng, k, null, null, 1, out);
        else if (policy === "ts") got = b.select(rng, k, null, null, 0, out);
        else {
          // Greedy by posterior mean (what ranking by a Beta posterior mean does today), ties to the lower index.
          const order = Array.from({ length: arms }, (_, i) => i).sort((x, y) => b.mean(y) - b.mean(x) || x - y);
          for (let j = 0; j < k; j++) out[j] = order[j]!;
          got = k;
        }
        sorted.set(p);
        sorted.sort();
        let best = 0;
        for (let j = 0; j < k; j++) best += sorted[arms - 1 - j]!;
        let got_ = 0;
        for (let j = 0; j < got; j++) {
          const a = out[j]!;
          got_ += p[a]!;
          b.update(a, env.uniform() < p[a]! ? 1 : 0);
        }
        b.decay(1);
        total += best - got_;
      }
      return total / T;
    };
    let ts = 0;
    let uni = 0;
    let greedy = 0;
    for (let seed = 1; seed <= 5; seed++) {
      ts += regret("ts", seed);
      uni += regret("uniform", seed);
      greedy += regret("greedy", seed);
    }
    expect(ts).toBeLessThan(uni);
    expect(ts).toBeLessThan(greedy);
  });
});
