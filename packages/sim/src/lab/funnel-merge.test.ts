import { describe, expect, test } from "bun:test";
import {
  amortisedCalls,
  callMismatches,
  defaultJobs,
  groupShards,
  mergeParts,
  zeroRow,
  type PartOut,
  type PartTask,
  type Rows,
} from "./funnel-merge";

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

  test("--time 0 without --jobs runs one process per core, at most one per shard (D139)", () => {
    expect(defaultJobs({ timeScale: 0, shards: 12, cores: 4 })).toBe(4);
    expect(defaultJobs({ timeScale: 0, shards: 2, cores: 4 })).toBe(2);
    expect(defaultJobs({ timeScale: 0, shards: 12, cores: 1 })).toBe(1);
    expect(defaultJobs({ timeScale: 0, shards: 12, cores: 0 })).toBe(1);
  });

  test("an explicit --jobs is kept as typed, capped at the shards", () => {
    expect(defaultJobs({ jobsGiven: 1, timeScale: 0, shards: 12, cores: 4 })).toBe(1);
    expect(defaultJobs({ jobsGiven: 1, timeScale: 1, shards: 12, cores: 4 })).toBe(1);
    expect(defaultJobs({ jobsGiven: 4, timeScale: 0, shards: 12, cores: 4 })).toBe(4);
    expect(defaultJobs({ jobsGiven: 20, timeScale: 1, shards: 12, cores: 4 })).toBe(12);
  });
});

describe("groupShards (D139)", () => {
  const train = ["train1", "train2", "train3", "train4", "train5", "train6"];
  const size = (g: { suites: string[]; seeds: string[] }) => g.suites.length * g.seeds.length;

  test("train × 2 seeds on 4 cores: four blocks of 3 suites × 1 seed, in shard order", () => {
    expect(groupShards(train, ["41", "42"], 4)).toEqual([
      { suites: ["train1", "train2", "train3"], seeds: ["41"] },
      { suites: ["train1", "train2", "train3"], seeds: ["42"] },
      { suites: ["train4", "train5", "train6"], seeds: ["41"] },
      { suites: ["train4", "train5", "train6"], seeds: ["42"] },
    ]);
  });

  test("every shard lands in exactly one block, and no more blocks than jobs", () => {
    for (const s of [1, 2, 5, 6, 13]) {
      for (const d of [1, 2, 3, 4]) {
        const suites = Array.from({ length: s }, (_, i) => `s${i}`);
        const seeds = Array.from({ length: d }, (_, i) => String(41 + i));
        for (const jobs of [1, 2, 3, 4, 5, 8, 12, 100]) {
          const groups = groupShards(suites, seeds, jobs);
          expect(groups.length).toBeLessThanOrEqual(jobs);
          const cells = groups.flatMap((g) => g.suites.flatMap((x) => g.seeds.map((y) => `${x}|${y}`)));
          expect(cells.sort()).toEqual(suites.flatMap((x) => seeds.map((y) => `${x}|${y}`)).sort());
          if (jobs >= s * d) expect(groups.every((g) => size(g) === 1)).toBe(true);
        }
      }
    }
  });

  test("the largest block is the smallest a cut allows; ties take fewer processes", () => {
    // 5 jobs over 6 × 2: five blocks would leave one of 4 shards; four blocks of 3 finish sooner and start fewer.
    expect(groupShards(train, ["41", "42"], 5).map(size)).toEqual([3, 3, 3, 3]);
    // One job is one block of everything; no suites or seeds is no block.
    expect(groupShards(train, ["41", "42"], 1)).toEqual([{ suites: train, seeds: ["41", "42"] }]);
    expect(groupShards([], ["41"], 4)).toEqual([]);
    expect(groupShards(["train1"], [], 4)).toEqual([]);
  });
});

describe("mergeParts (D139): blocks of suites × seeds merge to the one-process output", () => {
  interface Task extends PartTask {
    template: string;
    delivered: boolean;
    ms: number;
  }
  /** What hidden-funnel.ts writes for `suites` × `seeds` in one process, from a deterministic task per cell. */
  const fake = (suites: string[], seeds: number[]): PartOut => {
    const perTask: Task[] = [];
    const bySuite: Record<string, { rows: Record<string, Rows>; total: Rows }> = {};
    for (const suite of suites) {
      const s = (bySuite[suite] = {
        rows: {} as Record<string, Rows>,
        total: { hidden: zeroRow(), control: zeroRow() },
      });
      for (const variant of ["hidden", "control"] as const) {
        for (const seed of seeds) {
          for (const template of ["alpha", "beta"]) {
            const delivered = (suite.length + seed + template.length + variant.length) % 3 === 0;
            const t: Task = { suite, seed, variant, template, delivered, ms: seed };
            perTask.push(t);
            const r = (s.rows[template] ??= { hidden: zeroRow(), control: zeroRow() });
            for (const into of [r[variant], s.total[variant]]) {
              into.n++;
              into.delivered += Number(delivered);
              into.calls += 2;
              into.ms += t.ms;
            }
          }
        }
      }
    }
    const total = { hidden: zeroRow(), control: zeroRow() };
    for (const s of Object.values(bySuite)) {
      for (const v of ["hidden", "control"] as const) {
        for (const k of Object.keys(total[v]) as (keyof Rows["hidden"])[]) total[v][k] += s.total[v][k];
      }
    }
    const rows = Object.fromEntries(
      suites.flatMap((suite) =>
        Object.entries(bySuite[suite]!.rows).map(([k, v]) => [suites.length > 1 ? `${suite}/${k}` : k, v]),
      ),
    );
    return {
      rows,
      total,
      ...(suites.length > 1 ? { suites: bySuite } : {}),
      sync: { users: suites.length * seeds.length, polls: 3 },
      intent: { asked: seeds.length, found: 1 },
      perTask,
    };
  };

  test("a block spanning two suites merges in shard order, rows and totals as one process gives them", () => {
    const suites = ["train1", "train2", "train3"];
    const seeds = ["41", "42"];
    const whole = fake(suites, [41, 42]);
    // train1 and train2 share a process per seed; train3 runs both seeds in one; the blocks come out of order.
    const groups = [
      { suites: ["train3"], seeds: ["41", "42"] },
      { suites: ["train1", "train2"], seeds: ["42"] },
      { suites: ["train1", "train2"], seeds: ["41"] },
    ];
    const parts = groups.map((g) => fake(g.suites, g.seeds.map(Number)));
    const m = mergeParts(parts, groups, suites, seeds);
    expect(m.perTask).toEqual(whole.perTask);
    expect(m.rows).toEqual(whole.rows);
    expect(Object.keys(m.rows)).toEqual(Object.keys(whole.rows));
    expect(m.total).toEqual(whole.total);
    expect(m.bySuite).toEqual(whole.suites!);
    expect(m.sync).toEqual({ users: 6, polls: 9 });
    expect(m.intentUse).toEqual({ asked: 4, found: 3 });
    expect(m.cards).toBeUndefined();
  });

  test("one suite keeps unprefixed row keys, as hidden-funnel.ts does", () => {
    const whole = fake(["train1"], [41, 42]);
    const groups = [
      { suites: ["train1"], seeds: ["41"] },
      { suites: ["train1"], seeds: ["42"] },
    ];
    const m = mergeParts(
      groups.map((g) => fake(g.suites, g.seeds.map(Number))),
      groups,
      ["train1"],
      ["41", "42"],
    );
    expect(Object.keys(m.rows)).toEqual(["alpha", "beta"]);
    expect(m.rows).toEqual(whole.rows);
    expect(m.perTask).toEqual(whole.perTask);
  });

  test("a part that ran other shards than its block, or lacks a per-suite summary, is refused", () => {
    const g = [{ suites: ["train1", "train2"], seeds: ["41"] }];
    expect(() => mergeParts([fake(["train1", "train2"], [42])], g, ["train1", "train2"], ["41"])).toThrow(/task/);
    const { suites: _, ...flat } = fake(["train1", "train2"], [41]);
    expect(() => mergeParts([flat], g, ["train1", "train2"], ["41"])).toThrow(/per-suite/);
    expect(() => mergeParts([], g, ["train1", "train2"], ["41"])).toThrow(/parts/);
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
