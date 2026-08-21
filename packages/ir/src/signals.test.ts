import { describe, expect, test } from "bun:test";
import { takeSignals } from "./signals";
import type { TraceEvent } from "./types";

function ev(name: string, ok = true): TraceEvent {
  return { name, args: {}, ok };
}

describe("online signals", () => {
  test("a unique happy sequence is silent", () => {
    const seen = new Set<string>();
    const events = [ev("lookup"), ev("write"), ev("verifyWrite"), ev("notify")];
    expect(takeSignals(events, { duration_ms: 12, llmCalls: 1 }, seen)).toEqual([]);
  });

  test("near-duplicate results on the same tool are low-gain", () => {
    const dup = { name: "search", args: { q: "x" }, result: { hits: [1] }, ok: true };
    const out = takeSignals([dup, { ...dup }, { ...dup }], { duration_ms: 8, llmCalls: 1 }, new Set());
    expect(out.some((w) => w.kind === "low_gain")).toBe(true);
  });

  test("missing required check at finalize is an evidence gap", () => {
    const events = [ev("lookup"), ev("write"), ev("notify")];
    const out = takeSignals(events, { duration_ms: 3, llmCalls: 0 }, new Set(), ["verifyWrite"]);
    expect(out.some((w) => w.kind === "evidence_gap")).toBe(true);
  });

  test("one failure is not a streak", () => {
    const seen = new Set<string>();
    expect(takeSignals([ev("lookup"), ev("write", false)], { duration_ms: 4, llmCalls: 0 }, seen)).toEqual([]);
  });

  test("two consecutive failures emit fail_streak plus a budget snapshot", () => {
    const seen = new Set<string>();
    const events = [ev("lookup", false), ev("write", false)];
    const budget = { duration_ms: 40, llmCalls: 2, prompt_tokens: 11, completion_tokens: 3 };
    const out = takeSignals(events, budget, seen);
    expect(out.map((w) => w.kind)).toEqual(["fail_streak", "budget"]);
    expect(out[0]).toMatchObject({ at: 1, n: 2, duration_ms: 40, llmCalls: 2, prompt_tokens: 11, completion_tokens: 3 });
    expect(out[1]).toMatchObject({ kind: "budget", at: 1, duration_ms: 40, llmCalls: 2 });
    expect(takeSignals([...events, ev("notify", false)], budget, seen)).toEqual([]);
  });

  test("unmeasured runs omit token fields instead of faking zero", () => {
    const out = takeSignals([ev("a", false), ev("b", false)], { duration_ms: 1, llmCalls: 0 }, new Set());
    expect(out[0]).not.toHaveProperty("prompt_tokens");
    expect(out[0]).not.toHaveProperty("completion_tokens");
    expect(out[0]!.llmCalls).toBe(0);
  });

  test("a repeating tool bigram warns while the run is still short", () => {
    const seen = new Set<string>();
    expect(takeSignals([ev("search"), ev("write")], { duration_ms: 1, llmCalls: 0 }, seen)).toEqual([]);
    const out = takeSignals([ev("search"), ev("write"), ev("search"), ev("write")], { duration_ms: 9, llmCalls: 1 }, seen);
    expect(out.map((w) => w.kind)).toEqual(["repeat_ngram", "budget"]);
    expect(out[0]!.ngram).toEqual(["search", "write"]);
    expect(out[0]!.at).toBe(3);
  });

  test("the same tool three times in a row is a repeated n-gram", () => {
    const out = takeSignals([ev("search"), ev("search"), ev("search")], { duration_ms: 2, llmCalls: 0 }, new Set());
    expect(out[0]!.kind).toBe("repeat_ngram");
    expect(out[0]!.ngram).toEqual(["search", "search"]);
  });
});
