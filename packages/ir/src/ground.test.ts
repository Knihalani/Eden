import { describe, expect, test } from "bun:test";
import { isUsableOutput, judgeGrounding, usableTrace } from "./index";
import type { StretchTrace } from "./types";

function t(over: Partial<StretchTrace> = {}): StretchTrace {
  return {
    id: "t",
    events: [{ name: "lookup", args: {}, result: { id: 1 }, ok: true }],
    llmCalls: 1,
    duration_ms: 10,
    cost_cents: 1,
    ...over,
  };
}

describe("grounding", () => {
  test("empty-but-ok is not usable", () => {
    expect(isUsableOutput({})).toBe(false);
    expect(isUsableOutput("")).toBe(false);
    expect(isUsableOutput({ notified: true })).toBe(true);
    expect(usableTrace({ complete: true, output: {} })).toBe(false);
    expect(usableTrace({ complete: true, output: { notified: true } })).toBe(true);
  });

  test("absent output is judged once and cached", () => {
    const trace = t({ output: undefined, complete: true, evidence: { required: [], present: ["verifyWrite"], absent: [], failed: [] } });
    const first = judgeGrounding(trace);
    const second = judgeGrounding(trace);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(first.grounded).toBe(second.grounded);
  });
});
