import { describe, expect, test } from "bun:test";
import type { StretchProgram } from "@eden/ir";
import { decideGuard, requiredChecks } from "./guard";
import { emptyRun, type EdenOpts } from "./types";

/**
 * Guard-branch regressions from the waste audit.
 *
 * The budget and loop branches decide whether an in-flight run keeps
 * spending. Every branch here is one that previously had no direct test:
 * the budget steer picked whichever program came first rather than one that
 * fit the time left, and the loop branch hardened against productive polls
 * (see signals.ts repeatProgress / READ_NGRAM_REPEAT_AT).
 */

function tinyProgram(over: Partial<StretchProgram> = {}): StretchProgram {
  return {
    id: "p_tiny",
    version: "1",
    name: "tiny_bundle",
    description: "",
    inputSchema: { type: "object", properties: {} },
    sequence: ["get_issue", "list_comments"],
    steps: [],
    returns: { kind: "literal", value: null },
    contract: { witnesses: 3, minLlmReduction: 2 },
    ...over,
  } as unknown as StretchProgram;
}

/** Matches the nShadow the wrap tests use for a live manifest. */
const liveManifestN = 6;

function manifestOf(name: string): StretchProgram["manifest"] {
  return {
    name,
    llmReduction: 5,
    latencyReduction: 5,
    costReduction: 5,
    skipRateBefore: 0.2,
    skipRateAfter: 0,
    nShadow: liveManifestN,
  } as unknown as StretchProgram["manifest"];
}

function runWithLoopWarning(events: Array<{ name: string; ok?: boolean }>, ngram: string[]) {
  const run = emptyRun();
  for (const e of events) {
    run.events.push({ name: e.name, args: {}, ok: e.ok ?? true });
  }
  run.warnings.push({
    kind: "repeat_ngram",
    at: events.length - 1,
    detail: "test",
    duration_ms: 10,
    llmCalls: 1,
    ngram,
  });
  return run;
}

describe("guard loop branch", () => {
  const opts: EdenOpts = {};

  test("a stalled mixed loop with a live program steers to it", () => {
    const program = tinyProgram({
      id: "p_loop",
      name: "loop_bundle",
      sequence: ["search", "write"],
      manifest: manifestOf("loop_bundle"),
    });
    const run = runWithLoopWarning(
      [
        { name: "search" },
        { name: "write" },
        { name: "search" },
        { name: "write" },
      ],
      ["search", "write"],
    );
    const d = decideGuard({
      name: "search",
      run,
      live: [program],
      opts,
      now: performance.now(),
    });
    expect(d).toMatchObject({ action: "steer", reason: "loop" });
  });

  test("an all-read loop is never hard-stopped, even when stalled", () => {
    const run = runWithLoopWarning(
      [
        { name: "get_status" },
        { name: "get_log" },
        { name: "get_status" },
        { name: "get_log" },
        { name: "get_status" },
      ],
      ["get_status", "get_log"],
    );
    const d = decideGuard({
      name: "get_log",
      run,
      live: [],
      opts,
      now: performance.now(),
    });
    expect(d).toBeNull();
  });

  test("a mixed stalled loop with nothing compiled halts", () => {
    const run = runWithLoopWarning(
      [{ name: "search" }, { name: "write" }, { name: "search" }],
      ["search", "write"],
    );
    const d = decideGuard({
      name: "search",
      run,
      live: [],
      opts,
      now: performance.now(),
    });
    expect(d).toMatchObject({ action: "halt", reason: "loop" });
  });

  test("the incoming call must be part of the warned n-gram", () => {
    // An unrelated tool arriving after a loop warning elsewhere proceeds.
    const run = runWithLoopWarning([{ name: "a" }, { name: "b" }], ["a", "b"]);
    const d = decideGuard({ name: "unrelated", run, live: [], opts, now: performance.now() });
    expect(d).toBeNull();
  });
});

describe("guard budget branch", () => {
  function agedRun(ms: number) {
    const run = emptyRun();
    run.firstWarningAt = 1;
    run.t0 = performance.now() - ms;
    run.events.push({ name: "get_issue", args: {}, ok: true });
    return run;
  }

  test("steers only to a program that fits the time remaining", () => {
    const tooBig = tinyProgram({
      id: "p_big",
      name: "big_bundle",
      budget: { ms: 120_000, llmCalls: 8, cents: 8 },
      manifest: manifestOf("big_bundle"),
    });
    const fits = tinyProgram({
      id: "p_small",
      name: "small_bundle",
      budget: { ms: 5_000, llmCalls: 8, cents: 8 },
      manifest: manifestOf("small_bundle"),
    });
    const d = decideGuard({
      name: "list_comments",
      run: agedRun(10_000),
      live: [tooBig, fits],
      opts: { timeoutMs: 60_000 },
      now: performance.now(),
    });
    expect(d).toMatchObject({ action: "steer", reason: "budget", program: fits });
  });

  test("halts when nothing fits the time remaining", () => {
    const tooBig = tinyProgram({
      id: "p_big",
      name: "big_bundle",
      budget: { ms: 120_000, llmCalls: 8, cents: 8 },
      manifest: manifestOf("big_bundle"),
    });
    const d = decideGuard({
      name: "list_comments",
      run: agedRun(10_000),
      live: [tooBig],
      opts: { timeoutMs: 60_000 },
      now: performance.now(),
    });
    expect(d).toMatchObject({ action: "halt", reason: "budget" });
  });

  test("no budget branch without a prior warning", () => {
    const run = emptyRun();
    run.t0 = performance.now() - 500_000;
    const big = tinyProgram({
      id: "p_big",
      name: "big_bundle",
      budget: { ms: 300_000, llmCalls: 8, cents: 8 },
      manifest: manifestOf("big_bundle"),
    });
    expect(decideGuard({ name: "x", run, live: [big], opts: {}, now: performance.now() })).toBeNull();
  });

  test("unwarned matching spent (llmCalls) still budget-halts", () => {
    const run = emptyRun();
    run.t0 = 0;
    run.llmCalls = 2;
    run.events.push({ name: "get_issue", args: {}, ok: true });
    expect(run.firstWarningAt).toBeUndefined();
    const on = tinyProgram({
      id: "p_on",
      name: "on_bundle",
      budget: { ms: 80_000, llmCalls: 2, cents: 8 },
      manifest: manifestOf("on_bundle"),
    });
    const d = decideGuard({
      name: "list_comments",
      run,
      live: [on],
      opts: { timeoutMs: 60_000 },
      now: 1_000,
    });
    expect(d).toMatchObject({ action: "halt", reason: "budget", detail: "predicted llmCalls=2 actual=2" });
  });

  test("unwarned matching timeout-pressure still requires a warning", () => {
    const run = emptyRun();
    run.t0 = 0;
    run.events.push({ name: "get_issue", args: {}, ok: true });
    expect(run.firstWarningAt).toBeUndefined();
    const tooBig = tinyProgram({
      id: "p_big",
      name: "big_bundle",
      budget: { ms: 120_000, llmCalls: 8, cents: 8 },
      manifest: manifestOf("big_bundle"),
    });
    expect(
      decideGuard({
        name: "list_comments",
        run,
        live: [tooBig],
        opts: { timeoutMs: 60_000 },
        now: 10_000,
      }),
    ).toBeNull();
  });
});

describe("requiredChecks", () => {
  test("follows the run actually on a program, not the union of live tools", () => {
    const a = tinyProgram({ id: "pa", sequence: ["get_issue", "verifyWrite", "notify"] });
    const b = tinyProgram({ id: "pb", sequence: ["other", "verifyLint"] });
    const checks = requiredChecks([a, b], [{ name: "get_issue" }, { name: "verifyWrite" }]);
    expect(checks).toEqual(["verifyWrite"]);
  });

  test("skipped events do not identify the run", () => {
    const a = tinyProgram({ id: "pa", sequence: ["get_issue", "verifyWrite"] });
    expect(requiredChecks([a], [{ name: "get_issue", skipped: true }])).toEqual([]);
  });
});
