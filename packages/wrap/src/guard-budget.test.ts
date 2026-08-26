import { describe, expect, test } from "bun:test";
import { decideGuard } from "./guard";
import { emptyRun } from "./types";
import type { StretchProgram } from "@eden/ir";

/**
 * The budget branch must steer only to a program that *fits* the time left.
 * `|| Boolean(p.manifest)` used to make the predicate always true, so the
 * branch steered to whichever manifest program came first — even one that
 * could not fit and would itself deopt on timeout.
 */
function program(id: string, budgetMs: number): StretchProgram {
  return {
    id,
    version: "v1",
    name: `tool_${id}`,
    description: "",
    sequence: ["a", "b"],
    inputSchema: { type: "object" },
    steps: [],
    returns: { kind: "literal", value: null },
    contract: { witnesses: 3, minLlmReduction: 2, allowExact: false },
    manifest: {
      llmReduction: 5,
      latencyReduction: null,
      costReduction: 1,
      skipRateBefore: 0,
      skipRateAfter: 0,
      nShadow: 3,
    },
    budget: { ms: budgetMs, llmCalls: 1, cents: 0 },
  };
}

function run() {
  const r = emptyRun();
  // The budget branch is only reached after a first warning.
  r.firstWarningAt = 0;
  // Pin the run's clock origin. emptyRun stamps t0 from performance.now(),
  // so with the literal `now: 50_000` below this test only passed while the
  // whole suite finished within 50 seconds of process start — a longer suite
  // silently flipped these cases into "no time pressure". Control both ends
  // of the subtraction.
  r.t0 = -5_000;
  return r;
}

// opts.timeoutMs = 60_000, now = 50_000, t0 = -5_000
// → elapsed 55_000, cap 60_000, remaining 5_000.
const timing = { opts: { timeoutMs: 60_000 }, now: 50_000 };

describe("budget guard", () => {
  test("no warning-level time pressure means no guard action", () => {
    const d = decideGuard({ name: "b", run: run(), live: [program("small", 4_000)], ...timing });
    expect(d).toBeNull();
  });

  test("no fitting program halts instead of steering one that will deopt", () => {
    const d = decideGuard({ name: "b", run: run(), live: [program("big", 50_000)], ...timing });
    expect(d?.action).toBe("halt");
    expect(d?.reason).toBe("budget");
  });

  test("the fitting program wins even when listed after one that does not fit", () => {
    const live = [program("big", 50_000), program("small", 4_000)];
    const d = decideGuard({ name: "b", run: run(), live, ...timing });
    expect(d?.action).toBe("steer");
    if (d?.action === "steer") expect(d.program.id).toBe("small");
  });
});
