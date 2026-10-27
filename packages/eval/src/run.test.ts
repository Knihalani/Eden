import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runScenarios } from "./run";
import type { Scenario } from "./scenario";

const scenario = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "scenarios", "personal-assistant.json"), "utf8"),
) as Scenario;

describe("eval harness", () => {
  test("scores the seed scenario with no model: deterministic, free, and never fires on small talk", async () => {
    const m = await runScenarios([scenario], { model: null, waitMs: 1_000 });
    expect(m.scoredTurns).toBe(7);
    expect(m.falseFireRate).toBe(0);
    expect(m.modelCallsPerTurn).toBe(0);
    expect(m.recall).toBeGreaterThan(0);
  });
});
