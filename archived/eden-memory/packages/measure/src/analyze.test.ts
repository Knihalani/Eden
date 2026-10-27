import { describe, expect, test } from "bun:test";
import { analyze, extract, isPlaceboTask, poolPlacebo } from "./analyze";

const run = (rows: Array<[string, number, number]>) => ({
  scored: rows.map(([id, without, wall]) => ({ id, without: { wall_ms: without }, with: { wall_ms: wall } })),
});

describe("analyze", () => {
  test("recognises the placebo task", () => {
    // The harnesses pass `mcp: i > 0`, so task 1 runs with an empty MCP config
    // on both arms and can only measure noise.
    expect(isPlaceboTask("t1-build")).toBe(true);
    expect(isPlaceboTask("t1")).toBe(true);
    expect(isPlaceboTask("t2-extend")).toBe(false);
    expect(isPlaceboTask("t10-something")).toBe(false);
  });

  test("splits placebo rows out of the A/B sample", () => {
    const e = extract(
      "x.json",
      run([
        ["t1-a", 100, 130],
        ["t2-b", 200, 150],
        ["t3-c", 300, 250],
      ]),
    );
    expect(e.control.map((s) => s.task)).toEqual(["t2-b", "t3-c"]);
    expect(e.placeboControl.map((s) => s.value)).toEqual([100]);
    expect(e.placeboTreatment.map((s) => s.value)).toEqual([130]);
  });

  test("pools placebo cells across files without colliding their keys", () => {
    const a = extract("a.json", run([["t1-x", 100, 130]]));
    const b = extract("b.json", run([["t1-x", 200, 180]]));
    const pooled = poolPlacebo([a, b]);
    expect(pooled.a).toHaveLength(2);
    // Same task id in both files must remain two distinct blocks, or one would
    // overwrite the other when paired.
    expect(new Set(pooled.a.map((s) => `${s.task}#${s.repeat}`)).size).toBe(2);
  });

  test("skips rows missing the metric", () => {
    const e = extract("x.json", { scored: [{ id: "t2", without: {}, with: { wall_ms: 5 } }] });
    expect(e.control).toHaveLength(0);
  });

  test("reads cost_usd as readily as wall_ms", () => {
    const json = {
      scored: [{ id: "t2", without: { cost_usd: 1.5 }, with: { cost_usd: 2 } }],
    };
    const e = extract("x.json", json, "cost_usd");
    expect(e.control[0]!.value).toBe(1.5);
    expect(e.treatment[0]!.value).toBe(2);
  });

  test("refuses to call a three-task run, and says why", () => {
    // Exactly the shape of every committed Eden result: one placebo task plus
    // three real ones, n=1, all in the same direction.
    const report = analyze([
      {
        path: "/tmp/bench-example-results.json",
        json: run([
          ["t1-build", 100_000, 60_000],
          ["t2-extend", 200_000, 100_000],
          ["t3-report", 300_000, 115_000],
          ["t4-audit", 250_000, 120_000],
        ]),
      },
    ]);
    expect(report).toContain("NO DATA");
    expect(report).toContain("bench-example-results.json");
    expect(report).toMatch(/6 blocks are the minimum/);
    expect(report).not.toContain("WIN");
  });

  test("reports the noise floor when several placebo cells are available", () => {
    const files = [1, 2, 3, 4, 5, 6].map((i) => ({
      path: `/tmp/r${i}.json`,
      json: run([
        ["t1-build", 100_000, 100_000 + i * 5_000],
        ["t2-extend", 200_000, 190_000],
        ["t3-report", 300_000, 280_000],
      ]),
    }));
    const report = analyze(files);
    expect(report).toContain("Noise floor");
    expect(report).toMatch(/A\/A: treatment arm with Eden disabled, n=6/);
  });

  test("names files that have no scoreable tasks instead of dropping them", () => {
    const report = analyze([{ path: "/tmp/empty.json", json: { scored: [] } }]);
    expect(report).toContain("NO DATA  empty.json");
  });
});
