import { describe, expect, test } from "bun:test";
import { inDistribution } from "./envelope";
import { withVersion } from "./hash";
import type { StretchProgram } from "./types";

const mini = (contract: StretchProgram["contract"]): StretchProgram =>
  withVersion({
    id: "t",
    name: "t",
    description: "t",
    inputSchema: { type: "object" },
    steps: [{ id: "a", kind: "tool", tool: "x", args: { id: { kind: "input", path: "id" } } }],
    returns: { kind: "from", step: "a", path: "" },
    contract,
    manifest: null,
  });

describe("inDistribution with an empty envelope", () => {
  test("an empty envelope is out of distribution unless allowExact", () => {
    // An empty envelope used to fall through the zero-iteration loop and
    // return true for ANY input — vacuously "in distribution" while proving
    // nothing. Same rule as no envelope at all.
    const empty = mini({ witnesses: 3, minLlmReduction: 5, allowExact: false, envelope: { inputs: {} } });
    expect(inDistribution(empty, { id: "T-100" })).toBe(false);
    expect(inDistribution(empty, { anything: "goes" })).toBe(false);

    const exact = mini({ witnesses: 3, minLlmReduction: 5, allowExact: true, envelope: { inputs: {} } });
    expect(inDistribution(exact, { id: "T-100" })).toBe(true);
  });

  test("a non-empty envelope still constrains as before", () => {
    const p = mini({
      witnesses: 3,
      minLlmReduction: 5,
      allowExact: false,
      envelope: { inputs: { id: ["T-1", "T-2"] } },
    });
    expect(inDistribution(p, { id: "T-1" })).toBe(true);
    expect(inDistribution(p, { id: "T-100" })).toBe(false);
  });
});
