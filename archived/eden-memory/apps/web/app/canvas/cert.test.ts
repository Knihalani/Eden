import { describe, expect, test } from "bun:test";
import type { Manifest } from "@eden/ir/types";
import { tokensCertLine } from "./cert";

function m(over: Partial<Manifest> = {}): Manifest {
  return {
    llmReduction: 1,
    latencyReduction: null,
    costReduction: 0,
    skipRateBefore: 0,
    skipRateAfter: 0,
    nShadow: 1,
    ...over,
  };
}

describe("approval tokens line", () => {
  test("estimated or certified===false is Uncertified, never a savings number", () => {
    expect(tokensCertLine(m({ tokensEstimated: true, tokensMeasured: true, tokensSaved: 400 }))).toBe("Uncertified");
    expect(tokensCertLine(m({ certified: false, tokensMeasured: true, tokensSaved: 400 }))).toBe("Uncertified");
  });

  test("certified true is measured, not a token count", () => {
    expect(tokensCertLine(m({ certified: true, tokensMeasured: true, tokensSaved: 400 }))).toBe("Certified: measured");
  });

  test("absent cert falls back to measured or not measured", () => {
    expect(tokensCertLine(null)).toBe("Not measured");
    expect(tokensCertLine(m({ tokensMeasured: true, tokensSaved: 12 }))).toBe("12 tokens saved");
  });

  test("llmReduction is never an × LLM-call ratio", () => {
    const lines = [
      tokensCertLine(null),
      tokensCertLine(m({ llmReduction: 5.14 })),
      tokensCertLine(m({ llmReduction: 8, latencyReduction: 8, tokensMeasured: true, tokensSaved: 12 })),
      tokensCertLine(m({ llmReduction: 8, tokensEstimated: true, tokensMeasured: true, tokensSaved: 400 })),
      tokensCertLine(m({ llmReduction: 8, certified: true, tokensMeasured: true, tokensSaved: 400 })),
    ];
    expect(lines).toEqual(["Not measured", "Not measured", "12 tokens saved", "Uncertified", "Certified: measured"]);
    for (const line of lines) {
      expect(line).not.toMatch(/×/);
      expect(line).not.toMatch(/llmCalls/);
      expect(line).not.toMatch(/\d+x/i);
    }
  });
});
