import { describe, expect, test } from "bun:test";
import { endpointMix, FIXED_PRICES, inferEndpoint, repricedUsd } from "./reprice";

const GLM = "z-ai/glm-5.3-flash";

describe("re-pricing agent cost at a fixed endpoint", () => {
  test("a request's endpoint is the one whose prices give its billed cost within 3%", () => {
    // 1,000 in and 200 out at OpenInference (1.72e-8, 3.55e-8) and at Z.AI's list price (1.5e-7, 5e-7).
    expect(inferEndpoint(GLM, 1_000, 200, 1_000 * 1.72e-8 + 200 * 3.55e-8)).toBe("OpenInference");
    expect(inferEndpoint(GLM, 1_000, 200, (1_000 * 1.5e-7 + 200 * 5e-7) * 1.02)).toBe("Z.AI list");
    expect(inferEndpoint(GLM, 1_000, 200, 1)).toBe("unmatched");
    expect(inferEndpoint(GLM, 0, 0, 0)).toBe("unmatched");
    // No price table for the model: nothing is inferred.
    expect(inferEndpoint("other/model", 1_000, 200, 0.0001)).toBe("unmatched");
  });

  test("re-priced cost uses the request's tokens, whatever it was billed", () => {
    const reqs = [
      { in: 1_000, out: 100, cost: 0.5 },
      { in: 3_000, out: 300, cost: 0 },
    ];
    const zai = FIXED_PRICES["Z.AI list"]!;
    expect(repricedUsd(reqs, zai)).toBeCloseTo(4_000 * 1.5e-7 + 400 * 5e-7, 12);
  });

  test("the endpoint mix is each endpoint's share of a condition's requests", () => {
    const oi = { in: 1_000, out: 200, cost: 1_000 * 1.72e-8 + 200 * 3.55e-8 };
    const mix = endpointMix(GLM, [oi, oi, oi, { in: 1, out: 1, cost: 1 }]);
    expect(mix).toEqual([
      ["OpenInference", 0.75],
      ["unmatched", 0.25],
    ]);
    expect(endpointMix(GLM, [])).toEqual([]);
  });
});
