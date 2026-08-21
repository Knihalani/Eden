import { describe, expect, test } from "bun:test";
import { liveTimeSavedMs, withVersion, type StretchProgram } from "../src/index";

function program(budget?: { llmCalls: number; ms: number; cents: number }): StretchProgram {
  return withVersion({
    id: "t",
    name: "t",
    description: "t",
    inputSchema: { type: "object" },
    steps: [{ id: "a", kind: "tool", tool: "x", args: { id: { kind: "input", path: "id" } } }],
    returns: { kind: "from", step: "a", path: "" },
    contract: { witnesses: 3, minLlmReduction: 5, allowExact: false },
    manifest: {
      llmReduction: 5,
      latencyReduction: 5,
      costReduction: 5,
      skipRateBefore: 0,
      skipRateAfter: 0,
      nShadow: 6,
      timeSavedMs: 999,
      timeMeasured: true,
      tokensSaved: 400,
      tokensMeasured: true,
    },
    ...(budget ? { budget } : {}),
  });
}

describe("live 20b confirmation", () => {
  test("uses this-run ms against the naive tape, not the shadow estimate", () => {
    expect(liveTimeSavedMs(program({ llmCalls: 8, ms: 80, cents: 8 }), 12, true)).toBe(68);
  });

  test("omits savings when the tape was not measured", () => {
    expect(liveTimeSavedMs(program(), 12, true)).toBeNull();
    expect(liveTimeSavedMs(program({ llmCalls: 0, ms: 0, cents: 0 }), 12, true)).toBeNull();
  });

  test("failed runs did not save time", () => {
    expect(liveTimeSavedMs(program({ llmCalls: 8, ms: 80, cents: 8 }), 12, false)).toBeNull();
  });
});
