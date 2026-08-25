import { describe, expect, test } from "bun:test";
import { compiledTokens, compiledToolMs, isSyntheticDuration, naiveToolMs, SYNTHETIC_MS_PER_LLM, tokensExtrapolated, traceTokens } from "./measure";
import type { StretchTrace } from "@eden/ir";

function t(over: Partial<StretchTrace> = {}): StretchTrace {
  return {
    id: "t",
    events: [
      { name: "lookup", args: {}, ok: true, result: 1, duration_ms: 10 },
      { name: "write", args: {}, ok: true, result: 2, duration_ms: 40 },
    ],
    llmCalls: 4,
    duration_ms: SYNTHETIC_MS_PER_LLM * 4,
    cost_cents: 4,
    ...over,
  };
}

describe("20b measure", () => {
  test("synthetic 200×llm wall clock is not time", () => {
    expect(isSyntheticDuration(t())).toBe(true);
    expect(isSyntheticDuration(t({ duration_ms: 12 }))).toBe(false);
  });

  test("tokens absent is not measured", () => {
    expect(traceTokens(t())).toBeNull();
    expect(traceTokens(t({ prompt_tokens: 8, completion_tokens: 2 }))).toBe(10);
  });

  test("compiled time is FIFO event durations, not the whole naive sum", () => {
    expect(naiveToolMs(t())).toBe(50);
    expect(compiledToolMs(t(), ["write"])).toBe(40);
    expect(compiledTokens(t({ prompt_tokens: 80, completion_tokens: 0 }), 1, true)).toBe(20);
    expect(compiledTokens(t({ prompt_tokens: 80, completion_tokens: 0 }), 0, false)).toBe(0);
  });
});

describe("L6: token extrapolation keyed on compiled LLM use, not direct island steps", () => {
  test("a composed sub-program's island calls mark tokens estimated, not a fake zero", () => {
    // hasIsland=false but the compiled run DID make LLM calls through a
    // composed sub-program. The old code reported measured-zero.
    expect(tokensExtrapolated(2, false)).toBe(true);
    const t = { llmCalls: 4 } as never;
    expect(compiledTokens(t, 2, false)).not.toBe(0);
    expect(tokensExtrapolated(0, true)).toBe(false); // genuinely no provider work
  });
});
