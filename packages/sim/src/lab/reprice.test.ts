import { describe, expect, test } from "bun:test";
import { anthropicCost, anthropicPrice } from "@eden/llm";
import {
  cacheNeutral,
  endpointMix,
  ENDPOINT_PRICES,
  FIXED_PRICES,
  inferEndpoint,
  MODEL_PRICES,
  type PricedRequest,
  repricedUsd,
  requestUsd,
} from "./reprice";

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

  // Two requests of one task from D159's Pi pair (pi-41, eden~loose, a control task), as billed by Anthropic.
  const HAIKU = MODEL_PRICES["claude-haiku-5-5"]!;
  const first: PricedRequest = { in: 600, out: 138, cost: 0.0001439, cacheWrite: 596 };
  const second: PricedRequest = { in: 1_300, out: 288, cost: 0.00023791, cached: 596, cacheWrite: 702 };

  test("cache-write tokens are priced at the cache-write price: Haiku 5.5's requests reprice to what was billed", () => {
    expect(requestUsd(first, HAIKU)).toBeCloseTo(first.cost, 12);
    expect(requestUsd(second, HAIKU)).toBeCloseTo(second.cost, 12);
    // The same prices as the lab's Anthropic client books (5-minute TTL).
    for (const r of [first, second]) {
      const usage = {
        inputTokens: r.in,
        cachedInputTokens: r.cached ?? 0,
        cacheWriteTokens: r.cacheWrite ?? 0,
        outputTokens: r.out,
      };
      expect(requestUsd(r, HAIKU)).toBeCloseTo(anthropicCost(usage, anthropicPrice("claude-haiku-5-5")), 12);
    }
  });

  test("a price with no cache-write price bills written tokens as plain input, as before cacheWrite was recorded", () => {
    const zai = FIXED_PRICES["Z.AI list"]!;
    expect(requestUsd({ in: 1_000, out: 0, cost: 0, cacheWrite: 800 }, zai)).toBeCloseTo(1_000 * 1.5e-7, 12);
  });

  test("cached and written counts beyond the input are clamped, never priced as negative input", () => {
    // 100 in, recorded 80 cached and 50 written: 80 cached, the other 20 written, none plain.
    const over = { in: 100, out: 0, cost: 0, cached: 80, cacheWrite: 50 };
    expect(requestUsd(over, HAIKU)).toBeCloseTo(80 * 1e-8 + 20 * 1.25e-7, 15);
    expect(requestUsd({ in: 100, out: 0, cost: 0, cached: -5, cacheWrite: -5 }, HAIKU)).toBeCloseTo(100 * 1e-7, 15);
  });

  test("the cache-neutral price bills every input token as plain input, whoever wrote or read the cache", () => {
    expect(cacheNeutral(HAIKU)).toEqual([1e-7, 5e-7, 1e-7, 1e-7]);
    expect(repricedUsd([first, second], cacheNeutral(HAIKU))).toBeCloseTo(1_900 * 1e-7 + 426 * 5e-7, 12);
    // Two arms with the same tokens, one that wrote the cache and one that read the other's write: billed apart,
    // the same cache-neutral.
    const wrote = { in: 600, out: 100, cost: 0, cacheWrite: 596 };
    const read = { in: 600, out: 100, cost: 0, cached: 596 };
    expect(requestUsd(wrote, HAIKU) - requestUsd(read, HAIKU)).toBeCloseTo(596 * (1.25e-7 - 1e-8), 12);
    expect(requestUsd(wrote, cacheNeutral(HAIKU))).toBe(requestUsd(read, cacheNeutral(HAIKU)));
  });
});
