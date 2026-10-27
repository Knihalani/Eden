/**
 * The A/A noise floors, on runs whose metrics are made up so every floor is known.
 */
import { describe, expect, test } from "bun:test";
import { noiseFloors } from "./aa";
import { rate, type Metrics } from "./metrics";

function run(values: { stale: [number, number]; missed: (boolean | null)[]; p99?: number; digest?: string }) {
  const metrics = {
    stale_rate: rate(...values.stale),
    redundant_rate: rate(0, 0),
    need_miss_rate: rate(values.missed.filter(Boolean).length, values.missed.filter((m) => m !== null).length),
    false_rate: rate(0, 0),
    silence: { nonhuman: rate(0, 4), ack: rate(0, 0) },
    packet_rate: rate(1, 2),
    tokens_per_epoch: { epochs: 1, p99: 10, max: 10 },
    guard_precision: rate(0, 0),
    guard_recall: rate(0, 0),
    secret_bytes: 0,
    poison_hits: 0,
    p99_hook_ms: values.p99 === undefined ? {} : { UserPromptSubmit: { n: 1000, p50: 1, p99: values.p99, max: 1 } },
    bulletsByPoint: {},
    not_measured: {},
    cues: values.missed.map((missed, index) => ({
      index,
      text: "",
      missed,
      bullets: 0,
      false: 0,
      stale: 0,
      redundant: 0,
    })),
  } as Metrics;
  return {
    seconds: 1,
    digest: values.digest ?? "d",
    failOpen: { nonZeroExit: 0, timedOut: 0, withStderr: 0, rejectedOutput: 0 },
    metrics,
  };
}

describe("noise floors", () => {
  test("a floor is the largest spread between runs of one seed, never across seeds", () => {
    const floors = noiseFloors(
      {
        1: [run({ stale: [1, 10], missed: [true, false] }), run({ stale: [3, 10], missed: [true, false] })],
        2: [run({ stale: [5, 10], missed: [false, false] }), run({ stale: [5, 10], missed: [false, false] })],
      },
      [],
    );
    expect(floors.floors.stale_rate).toEqual({
      values: [
        [0.1, 0.3],
        [0.5, 0.5],
      ],
      floor: 0.2,
    });
    expect(floors.floors.redundant_rate!.floor).toBeNull();
    expect(floors.floors["silence.nonhuman"]!.floor).toBe(0);
    expect(floors.needMissDiscordantCues).toBe(0);
    expect(floors.digestsAgree).toBe(true);
  });

  test("need_miss discordance counts the cues whose outcome flips between two runs", () => {
    const floors = noiseFloors(
      {
        1: [
          run({ stale: [0, 1], missed: [true, false, null, true] }),
          run({ stale: [0, 1], missed: [false, false, null, false] }),
          run({ stale: [0, 1], missed: [true, true, null, true] }),
        ],
      },
      [],
    );
    expect(floors.needMissDiscordantCues).toBe(3);
  });

  test("p99 floors come from the soak runs; a digest that differs between runs is reported", () => {
    const floors = noiseFloors(
      { 1: [run({ stale: [0, 1], missed: [], digest: "a" }), run({ stale: [0, 1], missed: [], digest: "b" })] },
      [run({ stale: [0, 1], missed: [], p99: 120 }), run({ stale: [0, 1], missed: [], p99: 135.5 })],
    );
    expect(floors.p99.UserPromptSubmit).toEqual({ n: [1000, 1000], values: [120, 135.5], floor: 15.5 });
    expect(floors.digestsAgree).toBe(false);
  });
});
