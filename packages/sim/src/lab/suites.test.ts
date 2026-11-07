import { describe, expect, test } from "bun:test";
import { buildWorld } from "../world";
import { supportsNeutral } from "./neutral";
import { parseSuites, SUITE_NAMES, SUITES, UNRUN_BLIND } from "./suites";

describe("suite registry", () => {
  test("task ids are unique across a suite's hidden and control variants (runners key results by id)", () => {
    for (const [name, plant] of Object.entries(SUITES)) {
      const ids = (["hidden", "control"] as const).flatMap((v) =>
        plant(buildWorld({ seed: 41_000 }), 41, v).map((t) => t.id),
      );
      expect({ name, dupes: ids.length - new Set(ids).size }).toEqual({ name, dupes: 0 });
    }
  });

  test("every blind suite is registered, so the blind run can name it (heldout5-9)", () => {
    for (const n of [5, 6, 7, 8, 9]) expect(SUITE_NAMES).toContain(`heldout${n}`);
    expect(parseSuites("heldout9")).toEqual(["heldout9"]);
    // Neither `all` nor `heldout-all` runs a blind suite that has never been run: a tuning command with `--suite all`
    // must not spend it. It is only ever named on purpose, alone or in a list.
    expect(parseSuites("all")).not.toContain("heldout9");
    expect(parseSuites("all")).toContain("heldout8");
    expect(parseSuites("heldout-all")).not.toContain("heldout9");
    expect(parseSuites("all,heldout9")).toContain("heldout9");
  });

  test("heldout10 plants 32 tasks per variant, keeps the request text, and is left out of `all`", () => {
    const [hidden, control] = (["hidden", "control"] as const).map((v) =>
      SUITES.heldout10!(buildWorld({ seed: 41_000 }), 41, v),
    );
    expect(hidden!.length).toBe(32);
    expect(control!.map((t) => t.text)).toEqual(hidden!.map((t) => t.text));
    expect(hidden!.every((t) => t.id.startsWith("w41:heldout10:"))).toBe(true);
    expect(control!.every((t) => t.id.startsWith("w41:heldout10-control:"))).toBe(true);
    expect(parseSuites("all")).not.toContain("heldout10");
  });

  test("heldout11 plants 32 tasks per variant, keeps the request text, and is left out of `all`", () => {
    const [hidden, control] = (["hidden", "control"] as const).map((v) =>
      SUITES.heldout11!(buildWorld({ seed: 41_000 }), 41, v),
    );
    expect(hidden!.length).toBe(32);
    expect(control!.map((t) => t.text)).toEqual(hidden!.map((t) => t.text));
    expect(hidden!.every((t) => t.id.startsWith("w41:heldout11:"))).toBe(true);
    expect(control!.every((t) => t.id.startsWith("w41:heldout11-control:"))).toBe(true);
    expect(parseSuites("all")).not.toContain("heldout11");
  });

  test("heldout12 plants 32 tasks per variant, keeps the request text, and is left out of `all`", () => {
    const [hidden, control] = (["hidden", "control"] as const).map((v) =>
      SUITES.heldout12!(buildWorld({ seed: 41_000 }), 41, v),
    );
    expect(hidden!.length).toBe(32);
    expect(control!.map((t) => t.text)).toEqual(hidden!.map((t) => t.text));
    expect(hidden!.every((t) => t.id.startsWith("w41:heldout12:"))).toBe(true);
    expect(control!.every((t) => t.id.startsWith("w41:heldout12-control:"))).toBe(true);
    expect(parseSuites("all")).not.toContain("heldout12");
  });

  test("heldout9 plants tasks under its own name (counts and ids only: its templates are not read here)", () => {
    for (const v of ["hidden", "control"] as const) {
      const tasks = SUITES.heldout9!(buildWorld({ seed: 41_000 }), 41, v);
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks.every((t) => t.id.includes("heldout9"))).toBe(true);
    }
  });

  test("heldout15 builds 32 tasks per variant with neutral, unrun and out of `all` (counts and ids only)", () => {
    const by = Object.fromEntries(
      (["hidden", "control", "neutral"] as const).map((v) => {
        const world = buildWorld({ seed: 41_000 });
        const before = world.items.length;
        const tasks = SUITES.heldout15!(world, 41, v);
        return [v, { tasks, planted: world.items.length - before }];
      }),
    );
    for (const v of ["hidden", "control", "neutral"]) expect(by[v]!.tasks.length).toBe(32);
    expect([by.hidden!.planted, by.control!.planted, by.neutral!.planted]).toEqual([32, 32, 0]);
    expect(by.neutral!.tasks.map((t: { text: string }) => t.text)).toEqual(
      by.hidden!.tasks.map((t: { text: string }) => t.text),
    );
    expect(by.hidden!.tasks.every((t: { id: string }) => t.id.startsWith("w41:heldout15:"))).toBe(true);
    expect(by.neutral!.tasks.every((t: { id: string }) => t.id.startsWith("w41:heldout15-neutral:"))).toBe(true);
    expect(UNRUN_BLIND).toContain("heldout15");
    expect(supportsNeutral("heldout15")).toBe(true);
    expect(parseSuites("all")).not.toContain("heldout15");
  });
});
