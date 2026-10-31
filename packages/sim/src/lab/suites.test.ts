import { describe, expect, test } from "bun:test";
import { buildWorld } from "../world";
import { SUITES } from "./suites";

describe("suite registry", () => {
  test("task ids are unique across a suite's hidden and control variants (runners key results by id)", () => {
    for (const [name, plant] of Object.entries(SUITES)) {
      const ids = (["hidden", "control"] as const).flatMap((v) =>
        plant(buildWorld({ seed: 41_000 }), 41, v).map((t) => t.id),
      );
      expect({ name, dupes: ids.length - new Set(ids).size }).toEqual({ name, dupes: 0 });
    }
  });
});
