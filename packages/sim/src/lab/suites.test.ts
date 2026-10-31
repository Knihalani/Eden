import { describe, expect, test } from "bun:test";
import { buildWorld } from "../world";
import { parseSuites, SUITE_NAMES, SUITES } from "./suites";

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
    expect(parseSuites("all")).toContain("heldout9");
    // `heldout-all` stays the in-sample held-out set: a blind suite is only ever named on purpose.
    expect(parseSuites("heldout-all")).not.toContain("heldout9");
  });

  test("heldout9 plants tasks under its own name (counts and ids only: its templates are not read here)", () => {
    for (const v of ["hidden", "control"] as const) {
      const tasks = SUITES.heldout9!(buildWorld({ seed: 41_000 }), 41, v);
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks.every((t) => t.id.includes("heldout9"))).toBe(true);
    }
  });
});
