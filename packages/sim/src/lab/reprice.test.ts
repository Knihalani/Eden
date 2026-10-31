import { describe, expect, test } from "bun:test";
import { endpointMix, ENDPOINT_PRICES, FIXED_PRICES, inferEndpoint, repricedUsd, requestUsd } from "./reprice";

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

  test("the endpoints the 2026-10-31 listing had beyond the first table are inferred", () => {
    const at = (name: string, input: number, output: number) => {
      const [pi, po] = ENDPOINT_PRICES[GLM]![name]!;
      return inferEndpoint(GLM, input, output, input * pi + output * po);
    };
    for (const name of ["Reka", "Makora", "Inceptron", "Fireworks-us/Sail-us", "Sail fp4"]) {
      expect(at(name, 1_000, 1_000)).toBe(name);
    }
  });

  test("a request two endpoints both price within 3% is ambiguous, not given to whichever is nearer", () => {
    // 5k in and 100 out: Reka (1.2e-7, 3e-7) and CoreWeave (1.2e-7, 3.8e-7) are 1.3% apart.
    expect(inferEndpoint(GLM, 5_000, 100, 5_000 * 1.2e-7 + 100 * 3e-7)).toBe("ambiguous");
    // Output-heavy, CoreWeave is 22% dearer and Reka is told from it.
    expect(inferEndpoint(GLM, 1_000, 2_000, 1_000 * 1.2e-7 + 2_000 * 3e-7)).toBe("Reka");
    // Endpoints with the same input and output prices (only their cache prices differ) cannot be told apart on an
    // uncached request: both are named.
    expect(inferEndpoint(GLM, 1_000, 200, 1_000 * 1.125e-7 + 200 * 3.75e-7)).toBe("Phala/DigitalOcean");
  });

  test("no two endpoints in the table have the same prices (each would tie with the other on every request)", () => {
    const seen = new Set<string>();
    for (const p of Object.values(ENDPOINT_PRICES[GLM]!)) {
      const k = p.join(",");
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });

  test("cached input tokens are priced at the endpoint's cache-read price, when the request records them", () => {
    // Z.AI list: 1.5e-7 in, 5e-7 out, 3e-8 cache read. 4,000 in of which 3,000 cached, 100 out.
    const billed = 1_000 * 1.5e-7 + 3_000 * 3e-8 + 100 * 5e-7;
    expect(inferEndpoint(GLM, 4_000, 100, billed)).toBe("unmatched");
    expect(inferEndpoint(GLM, 4_000, 100, billed, { cached: 3_000 })).toBe("Z.AI list");
    expect(requestUsd({ in: 4_000, out: 100, cost: billed, cached: 3_000 }, FIXED_PRICES["Z.AI list"]!)).toBeCloseTo(
      billed,
      12,
    );
    const mix = endpointMix(GLM, [{ in: 4_000, out: 100, cost: billed, cached: 3_000 }]);
    expect(mix).toEqual([["Z.AI list", 1]]);
  });

  test("re-priced cost uses the request's tokens, whatever it was billed", () => {
    const reqs = [
      { in: 1_000, out: 100, cost: 0.5 },
      { in: 3_000, out: 300, cost: 0 },
    ];
    const zai = FIXED_PRICES["Z.AI list"]!;
    expect(repricedUsd(reqs, zai)).toBeCloseTo(4_000 * 1.5e-7 + 400 * 5e-7, 12);
    // With 2,000 of the second request's input cached, those are re-priced at the cache price (3e-8).
    const cached = [reqs[0]!, { ...reqs[1]!, cached: 2_000 }];
    expect(repricedUsd(cached, zai)).toBeCloseTo(2_000 * 1.5e-7 + 2_000 * 3e-8 + 400 * 5e-7, 12);
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
