import { describe, expect, test } from "bun:test";
import { mcnemar, mergeSides, paired, pooled, stated, missed, wilson, type Run, type Side } from "./slice-guards";
import { quantile } from "./submit-timing";

function run(cues: [boolean | null, number, number][], stale = 0): Run {
  const rate = { k: 0, n: 1 };
  return {
    digest: "d",
    metrics: {
      stale_rate: { k: stale, n: 10 },
      need_miss_rate: rate,
      false_rate: rate,
      redundant_rate: rate,
      packet_rate: rate,
      silence: { nonhuman: rate, ack: rate },
      secret_bytes: 0,
      poison_hits: 0,
      tokens_per_epoch: { p99: 1 },
      cues: cues.map(([missedCue, bullets, falseBullets]) => ({ missed: missedCue, bullets, false: falseBullets })),
    },
  };
}

describe("slice-guards", () => {
  test("the exact McNemar test and the Wilson interval", () => {
    expect(mcnemar(4, 0)).toBe(0.125);
    expect(mcnemar(7, 3)).toBeCloseTo(0.34375, 6);
    expect(mcnemar(0, 0)).toBe(1);
    const [low, high] = wilson({ k: 0, n: 405 });
    expect(low).toBe(0);
    expect(high).toBeCloseTo(0.0094, 4);
  });

  test("files merge by seed, and rates pool over every run", () => {
    const side = mergeSides([{ world: { "1": [run([], 1)] } }, { world: { "2": [run([], 2)], "1": [run([], 3)] } }]);
    expect(Object.keys(side).sort()).toEqual(["1", "2"]);
    expect(side["1"]).toHaveLength(2);
    expect(pooled(side, "stale_rate")).toEqual({ k: 6, n: 30 });
  });

  test("pairs are run r against run r of the same seed, cue by cue", () => {
    const base: Side = {
      "1": [
        run([
          [true, 0, 0],
          [true, 0, 0],
          [false, 2, 1],
          [null, 1, 1],
        ]),
      ],
    };
    const next: Side = {
      "1": [
        run([
          [false, 0, 0],
          [true, 0, 0],
          [true, 1, 1],
          [true, 0, 0],
        ]),
      ],
    };
    expect(paired(base, next, missed)).toEqual({ baseOnly: 1, newOnly: 1, both: 1, neither: 0, p: 1 });
    expect(paired(base, next, stated)).toMatchObject({ baseOnly: 1, newOnly: 0, both: 0, neither: 3 });
    expect(paired(base, { "1": [] }, missed)).toBeUndefined();
  });

  test("timing quantiles are nearest-rank", () => {
    const sample = Array.from({ length: 1000 }, (_, i) => i + 1);
    expect(quantile(sample, 0.5)).toBe(500);
    expect(quantile(sample, 0.99)).toBe(990);
  });
});
