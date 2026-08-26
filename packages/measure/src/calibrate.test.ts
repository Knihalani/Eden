import { describe, expect, test } from "bun:test";
import {
  calibrate,
  normalFrom,
  predictFalseLossRate,
  predictLossVerdictRate,
  stabilityScore,
  type AaPair,
} from "./calibrate";
import { minDetectableEffect, mulberry32, stdev } from "./stats";

/** Deterministic synthetic A/A pairs with a known absolute delta sd. */
function pairsFromDeltas(base: number, deltas: number[]): AaPair[] {
  return deltas.map((d, i) => {
    const a = base + (i % 3) * 0.01; // slight level variation, still known-ish
    return { a, b: a + d };
  });
}

describe("calibrate", () => {
  test("known-sd MDE matches minDetectableEffect at n=8/12/16", () => {
    // Build pairs whose (b-a) have a fixed sample sd.
    const deltas = [10, -10, 10, -10, 10, -10, 10, -10, 5, -5, 5, -5];
    const pairs = pairsFromDeltas(1000, deltas);
    const sd = stdev(deltas);
    const cal = calibrate(pairs, {
      ns: [8, 12, 16],
      falseLossTrials: 200,
      lossVerdictTrials: 100,
      seed: 1,
    });
    expect(cal.deltaSd).toBeCloseTo(sd, 10);
    for (const row of cal.mde) {
      expect(row.absolute).toBeCloseTo(minDetectableEffect(sd, row.n), 10);
      expect(row.relative).toBeCloseTo(row.absolute / Math.abs(cal.meanA), 10);
    }
  });

  test("stability score is in [0, 1] and hits the frozen anchors", () => {
    expect(stabilityScore(0)).toBe(1);
    expect(stabilityScore(0.025)).toBeCloseTo(0.5, 10);
    expect(stabilityScore(0.05)).toBe(0);
    expect(stabilityScore(0.2)).toBe(0);
    expect(stabilityScore(-1)).toBe(0);
    const quiet = calibrate(
      Array.from({ length: 8 }, () => ({ a: 1000, b: 1000.1 })),
      { falseLossTrials: 50, lossVerdictTrials: 20, seed: 2 },
    );
    expect(quiet.stability).toBeGreaterThanOrEqual(0);
    expect(quiet.stability).toBeLessThanOrEqual(1);
  });

  test("false-loss predictor ~0.5 for huge jitter and ~0 for tiny at 0.1% overhead", () => {
    const trueRel = 0.001;
    const huge = predictFalseLossRate(1.0, trueRel, 8, { trials: 5000, seed: 42 });
    const tiny = predictFalseLossRate(1e-9, trueRel, 8, { trials: 2000, seed: 42 });
    expect(huge).toBeGreaterThan(0.4);
    expect(huge).toBeLessThan(0.6);
    expect(tiny).toBeLessThan(0.02);
  });

  test("loss-verdict rate is high for tiny jitter and low for huge at 0.1%", () => {
    const trueRel = 0.001;
    const huge = predictLossVerdictRate(1.0, trueRel, 8, { trials: 800, seed: 7, alpha: 0.05 });
    const tiny = predictLossVerdictRate(1e-6, trueRel, 8, { trials: 400, seed: 7, alpha: 0.05 });
    expect(huge).toBeLessThan(0.15);
    expect(tiny).toBeGreaterThan(0.85);
  });

  test("normalFrom / predictors never call Math.random", () => {
    const original = Math.random;
    let calls = 0;
    Math.random = () => {
      calls++;
      return original();
    };
    try {
      const rand = mulberry32(99);
      for (let i = 0; i < 20; i++) normalFrom(rand);
      predictFalseLossRate(0.02, 0.001, 8, { trials: 50, seed: 3 });
      predictLossVerdictRate(0.02, 0.001, 8, { trials: 30, seed: 3 });
      calibrate(
        [
          { a: 100, b: 101 },
          { a: 110, b: 108 },
          { a: 105, b: 106 },
          { a: 102, b: 100 },
        ],
        { falseLossTrials: 40, lossVerdictTrials: 20, seed: 4 },
      );
      expect(calls).toBe(0);
    } finally {
      Math.random = original;
    }
  });

  test("calibrate is deterministic for a fixed seed", () => {
    const pairs = pairsFromDeltas(
      500,
      [3, -1, 4, -1, 5, 9, -2, 6],
    );
    const a = calibrate(pairs, { seed: 11, falseLossTrials: 200, lossVerdictTrials: 80 });
    const b = calibrate(pairs, { seed: 11, falseLossTrials: 200, lossVerdictTrials: 80 });
    expect(a).toEqual(b);
  });
});
