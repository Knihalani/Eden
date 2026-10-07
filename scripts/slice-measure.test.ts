import { describe, expect, test } from "bun:test";
import { DEFAULT_MEASURES, loadAffected, measuresFor, parallelTasks, selectMeasures } from "./slice-measure";

describe("slice-measure: what a change can affect", () => {
  test("docs, tests, tooling and apps need no measurement", () => {
    for (const file of [
      "docs/memory-ship/reports/P0.2.md",
      "CLAUDE.md",
      ".claude/commands/slice.md",
      "src/memory-validity.test.ts",
      "benchmarks/memory-long-horizon/arms/arms.gate.test.ts",
      "scripts/slice-measure.ts",
      "apps/web/app/page.tsx",
      "benchmarks/campaign/bench-helix.ts",
    ])
      expect(measuresFor(file)).toEqual([]);
  });

  test("an arms record needs the arms; the locked bench's tree needs the bench", () => {
    expect(measuresFor("benchmarks/memory-long-horizon/arms.json")).toEqual(["arms"]);
    expect(measuresFor("benchmarks/memory-scale/locked-2k.ts")).toEqual(["bench"]);
  });

  test("code the hook may load, the harness and dependencies need every default measure", () => {
    for (const file of [
      "src/memory-validity.ts",
      "packages/cli/src/memory-hook.ts",
      "plugins/eden-memory/scripts/hook.ts",
      "packages/ir/src/index.ts",
      "benchmarks/memory-long-horizon/harness/metrics.ts",
      "bun.lock",
    ])
      expect(measuresFor(file)).toEqual(DEFAULT_MEASURES);
  });

  test("a change's measures are the union, in the default order, with the file that asked for each", () => {
    expect(selectMeasures(["docs/a.md", "src/x.test.ts"]).measures).toEqual([]);
    const selected = selectMeasures(["benchmarks/memory-long-horizon/arms.json", "benchmarks/memory-scale/hard.ts"]);
    expect(selected.measures).toEqual(["arms", "bench"]);
    expect(selected.because.get("bench")).toBe("benchmarks/memory-scale/hard.ts");
    expect(selectMeasures(["docs/a.md", "src/sleep.ts"]).measures).toEqual([...DEFAULT_MEASURES]);
  });
});

describe("slice-measure: the parallel phase", () => {
  const base = { next: "/new", out: "/out", worlds: [] as number[] };

  test("the arms run as four processes, guards one per seed, longest first", () => {
    const tasks = parallelTasks({ ...base, measures: ["arms", "guards"] });
    expect(tasks.map((task) => task.name)).toEqual([
      "guards-new-1",
      "guards-new-2",
      "guards-new-3",
      "arms-on-1",
      "arms-on-2",
      "arms-off",
      "arms-shadow",
    ]);
    expect(tasks.find((task) => task.name === "arms-off")!.cmd).toContain("off");
  });

  test("base guards run only without earlier base guard files; worlds keep one directory per run", () => {
    const withBase = parallelTasks({ ...base, base: "/base", measures: ["guards"] });
    expect(withBase.filter((task) => task.name.startsWith("guards-base-"))).toHaveLength(3);
    const reused = parallelTasks({ ...base, base: "/base", guardBase: ["/old.json"], measures: ["guards"] });
    expect(reused.some((task) => task.name.startsWith("guards-base-"))).toBe(false);
    const worlds = parallelTasks({ ...base, worlds: [1, 2, 2], measures: ["worlds"] });
    expect(worlds.map((task) => task.name)).toEqual(["world-1-1", "world-2-1", "world-2-2"]);
    expect(worlds[2]!.cmd.at(-1)).toBe("/out/world-2-2");
  });
});

describe("slice-measure: counts the load may have changed", () => {
  const run = (digest: string, timedOut = 0) => ({ digest, failOpen: { timedOut, nonZeroExit: 0 } });

  test("a guard run with a hook timeout, or one seed's runs on different events, is re-run alone", () => {
    expect(loadAffected("guards", 0, { world: { "1": [run("a"), run("a")] } })).toBeUndefined();
    expect(loadAffected("guards", 0, { world: { "1": [run("a", 1), run("a")] } })).toBe(
      "1 hook timeouts, 0 non-zero exits",
    );
    expect(loadAffected("guards", 0, { world: { "1": [run("a"), run("b")] } })).toBe(
      "runs of one seed on different events",
    );
    expect(loadAffected("guards", 1, undefined)).toBe("no result (exit 1)");
  });

  test("an R6 replay or world replay is judged by its fail-open counts; an arms run by its mismatches", () => {
    expect(loadAffected("r6", 0, { failOpen: { timedOut: 0, nonZeroExit: 0 } })).toBeUndefined();
    expect(loadAffected("worlds", 0, { failOpen: { timedOut: 2, nonZeroExit: 0 } })).toBe(
      "2 hook timeouts, 0 non-zero exits",
    );
    expect(loadAffected("arms", 0, undefined)).toBeUndefined();
    expect(loadAffected("arms", 1, undefined)).toBe("an arms mismatch");
  });
});
