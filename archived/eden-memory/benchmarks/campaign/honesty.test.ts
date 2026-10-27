import { describe, expect, test } from "bun:test";
import { diagnoseHonesty, renderHonestyLetter, type StretchTrace } from "@eden/ir";

/**
 * Wave 9 rotation: honesty diagnoses on campaign-shaped traces.
 * Not a retune of unique-work / micro cost tables — class + count only.
 */
function trace(id: string, names: string[], input: Record<string, unknown> = {}): StretchTrace {
  return {
    id,
    llmCalls: names.length,
    duration_ms: 1,
    cost_cents: 0,
    input,
    complete: true,
    events: names.map((name) => ({ name, args: input, result: { ok: true }, ok: true })),
  };
}

describe("Wave 9 honesty rotation", () => {
  test("unique-work shape: 8 distinct sequences → Unique work with the count", () => {
    const traces = Array.from({ length: 8 }, (_, i) => trace(`u${i}`, ["alpha", "beta", `step${i}`], { id: `n${i}` }));
    const letter = renderHonestyLetter({ findings: diagnoseHonesty(traces) });
    expect(letter).toMatch(/Unique work · 8 distinct sequences in 8 stretches/);
  });

  test("micro shape: 16 × 2-call → Too short · 16 stretches of 2 calls (need 3)", () => {
    const traces = Array.from({ length: 16 }, (_, i) => trace(`m${i}`, ["a", "b"], { id: "T" }));
    const letter = renderHonestyLetter({ findings: diagnoseHonesty(traces) });
    expect(letter).toMatch(/Too short · 16 stretches of 2 calls \(need 3\)/);
    expect(letter).toMatch(/Wrap a stretch of at least three steps/);
  });
});
