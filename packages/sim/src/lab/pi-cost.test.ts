import { describe, expect, test } from "bun:test";
import type { Background, RunResult, Task } from "./ab-common";
import { emptyResult } from "./ab-common";
import { conditionCosts, costTasks, countSpans, dayRows, kindRows, lifetimeFor, p50, type CostTask } from "./pi-cost";

const t = (o: Partial<CostTask>): CostTask => ({
  seed: 41,
  condition: "eden",
  kind: "neutral",
  day: 0,
  agentUsd: 0.001,
  edenUsd: 0.0002,
  wallS: 2,
  agentTools: 0,
  readerCalls: 1,
  edenSourceCalls: 2,
  ...o,
});
const bg = (o: Partial<Background>): Background => ({
  seed: 41,
  suite: "train1",
  condition: "eden",
  tasks: [],
  cardsUsd: 0,
  bridgeUsd: 0,
  calls: 0,
  ...o,
});

describe("pi-cost (H16)", () => {
  test("steady state books the background after the first request; all-in adds the one-time backfill", () => {
    const tasks = [t({}), t({}), t({ agentUsd: 0.003 }), t({ agentUsd: 0.003 })];
    const [c] = conditionCosts(tasks, [bg({ cardsUsd: 0.05, setupUsd: 0.04 })], []);
    expect(c!.agent).toBeCloseTo(0.002, 9);
    expect(c!.eden).toBeCloseTo(0.0002, 9);
    expect(c!.backgroundRun).toBeCloseTo(0.01 / 4, 9);
    expect(c!.steady).toBeCloseTo(0.002 + 0.0002 + 0.0025, 9);
    expect(c!.oneTimeFrom).toBe("in-run");
    expect(c!.oneTimePerUser).toBeCloseTo(0.04, 9);
    expect(c!.allIn).toBeCloseTo(c!.steady + 0.04 / 4, 9);
    expect(c!.mixSteady).toBeNull();
  });

  test("a measured cold start replaces the in-run setup when every user has one; tools books none", () => {
    const tasks = [t({ seed: 41 }), t({ seed: 42 }), t({ seed: 41, condition: "tools", edenUsd: 0 })];
    const bgs = [bg({ seed: 41, setupUsd: 0, cardsUsd: 0 }), bg({ seed: 42, setupUsd: 0, cardsUsd: 0 })];
    const cold = [
      { seed: 41, usd: 0.02 },
      { seed: 42, usd: 0.03 },
    ];
    const [eden, tools] = conditionCosts(tasks, bgs, [], cold);
    expect(eden!.oneTimeFrom).toBe("cold-start");
    expect(eden!.oneTimePerUser).toBeCloseTo(0.025, 9);
    expect(eden!.allIn).toBeCloseTo(eden!.steady + 0.05 / 2, 9);
    expect(tools!.oneTimeFrom).toBe("none");
    expect(tools!.allIn).toBe(tools!.steady);
    // Only one seed covered: back to the run's own setup spend.
    expect(conditionCosts(tasks, bgs, [], [cold[0]!])[0]!.oneTimeFrom).toBe("in-run");
  });

  test("the mix weighs per-kind means 0.1/0.1/0.8", () => {
    const tasks = [
      t({ kind: "hidden", agentUsd: 0.01, edenUsd: 0 }),
      t({ kind: "control", agentUsd: 0.02, edenUsd: 0 }),
      t({ kind: "neutral", agentUsd: 0.001, edenUsd: 0 }),
      t({ kind: "neutral", agentUsd: 0.003, edenUsd: 0 }),
    ];
    const [c] = conditionCosts(tasks, [], []);
    expect(c!.mixSteady).toBeCloseTo(0.1 * 0.01 + 0.1 * 0.02 + 0.8 * 0.002, 9);
  });

  test("recaps are summed apart; kinds and days are split", () => {
    const tasks = [t({ day: 0, raised: true, kind: "hidden" }), t({ day: 1, raised: false, kind: "hidden" })];
    const [c] = conditionCosts(tasks, [], [{ seed: 41, condition: "eden", usd: 0.004 }]);
    expect(c!.recapUsd).toBe(0.004);
    expect(kindRows(tasks)[0]).toMatchObject({ kind: "hidden", n: 2, graded: 2, raised: 1 });
    expect(dayRows(tasks).map((r) => r.day)).toEqual([0, 1]);
    expect(p50([3, 1, 2, 10])).toBe(2);
  });

  test("costTasks reads results, timeline spans and days; errors are left out", () => {
    const task: Task = {
      id: "w41:train1:x",
      suite: "train1",
      kind: "hidden",
      type: "x",
      event: "user_message",
      text: "do it",
      must: [{ id: "x", detail: "d" }],
      secrets: [],
    };
    const ok: RunResult = { ...emptyResult(task.id, "eden"), costUsd: 0.001, edenCostUsd: 0.0003, wallMs: 1500 };
    ok.facts = { x: true };
    const bad: RunResult = { ...emptyResult(task.id, "tools"), error: "boom" };
    const events = [
      { ph: "B", ev: "eden.reader" },
      { ph: "E", ev: "eden.reader" },
      { ph: "B", ev: "eden.source" },
      { ph: "B", ev: "eden.source" },
    ];
    expect(countSpans(events, "eden.source")).toBe(2);
    const rows = costTasks(
      { tasks: [task], results: [ok, bad], seeds: [41] },
      new Map([[`${task.id}\u0000eden`, { events }]]),
      new Map([[task.id, 3]]),
    );
    expect(rows).toEqual([
      {
        seed: 41,
        condition: "eden",
        kind: "hidden",
        day: 3,
        agentUsd: 0.001,
        edenUsd: 0.0003,
        wallS: 1.5,
        agentTools: 0,
        readerCalls: 1,
        edenSourceCalls: 2,
        raised: true,
      },
    ]);
  });

  test("lifetimeFor: user rows of the runs' own shape, one per seed; anything else refused", () => {
    const shape = {
      suites: ["train1"],
      days: 8,
      daySize: [12, 20] as [number, number],
      mix: { hidden: 1, control: 1, neutral: 8 },
    };
    const file = {
      users: [
        { user: "user:41", seed: 41, usd: 0.02 },
        { user: "train1:41", seed: 41, usd: 0.5 },
      ],
      userShape: shape,
    };
    expect(lifetimeFor([file], [{ file: "a.json", shape }])).toEqual([{ seed: 41, usd: 0.02 }]);
    expect(lifetimeFor([], [{ file: "short.json" }])).toEqual([]);
    expect(() => lifetimeFor([file], [{ file: "short.json" }])).toThrow(/no --days/);
    expect(() => lifetimeFor([file], [{ file: "a.json", shape: { ...shape, days: 4 } }])).toThrow(/is not/);
    expect(() => lifetimeFor([file, file], [{ file: "a.json", shape }])).toThrow(/two cold starts/);
    expect(() => lifetimeFor([{ users: file.users }], [{ file: "a.json", shape }])).toThrow(/user shape/);
  });
});
