import { describe, expect, test } from "bun:test";
import { amortisedCalls, callMismatches, defaultJobs } from "./funnel-merge";

describe("amortisedCalls (audit 2026-11-03b, lab-merged-amortised-double-counts-behind-polls)", () => {
  test("polls left behind (demand < demandSeen) are counted once, as each shard counts them", () => {
    // Two shards of 64 tasks under ALL3 + syncPollBehind: the lookups' traces carry almost none of the polls
    // (`demand`), the connectors saw them all in the tasks' windows (`demandSeen`, inside `request`).
    const a = { demand: 5, demandSeen: 177, demandAll: 177, background: 38, backfill: 36 };
    const b = { demand: 4, demandSeen: 172, demandAll: 172, background: 36, backfill: 36 };
    const requestA = 225;
    const requestB = 189;
    const shardA = amortisedCalls(requestA, a) / 64;
    const shardB = amortisedCalls(requestB, b) / 64;
    const summed: Record<string, number> = {};
    for (const s of [a, b]) for (const [k, v] of Object.entries(s)) summed[k] = (summed[k] ?? 0) + v;
    const merged = amortisedCalls(requestA + requestB, summed) / 128;
    expect(merged).toBeCloseTo((shardA + shardB) / 2, 10);
    // The old formula (minus `demand`) put every poll in twice: (414 + 349 - 9 + 74 + 72) / 128 = 7.03.
    expect(merged).toBeCloseTo((414 + 74 + 72) / 128, 10);
    // Where every poll is traced (demand = demandSeen) both formulas agree.
    expect(amortisedCalls(100, { demand: 40, demandSeen: 40, demandAll: 40, background: 3, backfill: 2 })).toBe(105);
  });

  test("polls outside the tasks' windows (demandAll > demandSeen) are added", () => {
    expect(amortisedCalls(100, { demandSeen: 40, demandAll: 46, background: 0, backfill: 0 })).toBe(106);
  });
});

describe("defaultJobs (audit 2026-11-03b, devloop-time-screen-jobs-default)", () => {
  test("--time > 0 without --jobs runs min(shards, 12, 3 × cores) at once", () => {
    expect(defaultJobs({ timeScale: 1, shards: 12, cores: 4 })).toBe(12);
    expect(defaultJobs({ timeScale: 1, shards: 12, cores: 2 })).toBe(6);
    expect(defaultJobs({ timeScale: 1, shards: 48, cores: 64 })).toBe(12);
    expect(defaultJobs({ timeScale: 1, shards: 2, cores: 4 })).toBe(2);
  });

  test("--time 0 keeps one; an explicit --jobs is kept as typed, capped at the shards", () => {
    expect(defaultJobs({ timeScale: 0, shards: 12, cores: 4 })).toBe(1);
    expect(defaultJobs({ jobsGiven: 1, timeScale: 1, shards: 12, cores: 4 })).toBe(1);
    expect(defaultJobs({ jobsGiven: 4, timeScale: 0, shards: 12, cores: 4 })).toBe(4);
    expect(defaultJobs({ jobsGiven: 20, timeScale: 1, shards: 12, cores: 4 })).toBe(12);
  });
});

describe("callMismatches (audit 2026-11-03b, corr-poll-behind-calls-untraced)", () => {
  test("names each shard whose traces summed other than its connectors received", () => {
    expect(
      callMismatches([
        { name: "train1 seed 41", calls: { received: 225, listed: 177, traced: 53 } },
        { name: "train1 seed 42", calls: { received: 192, listed: 170, traced: 192 } },
        { name: "old shard", calls: undefined },
      ]),
    ).toEqual(["train1 seed 41: traced 53 of 225 received"]);
  });
});
