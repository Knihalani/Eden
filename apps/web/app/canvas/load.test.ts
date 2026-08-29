import { describe, expect, test } from "bun:test";
import { liveFailFromReceipt, canvasOrigin } from "./load";
import type { StretchProgram } from "@eden/ir";

const program = {
  id: "t1",
  version: "v1",
  name: "pr_summary",
  description: "Summarize a PR",
  inputSchema: { type: "object" },
  steps: [],
  returns: { kind: "literal", value: null },
  contract: { witnesses: 0, minLlmReduction: 2, allowExact: false },
  sequence: ["Read", "Grep", "Bash"],
  manifest: { skipRateAfter: 0 },
} as StretchProgram;

describe("live canvas load forwards remainder onto classifyFail", () => {
  test("skipped tails without a deny sentence still name the program", () => {
    const { fail, receipt } = liveFailFromReceipt(program, {
      ok: 1,
      skipped: ["Grep"],
    });
    expect(receipt?.skipped).toEqual(["Grep"]);
    expect(fail?.kind).toBe("skipped");
    expect(fail?.step).toBe("Grep");
    expect(fail?.detail).toMatch(/pr_summary/);
    expect(fail?.next).toMatch(/facts are in the last tool output or attached as context/i);
  });

  test("steered-skip class does not need reason on the row", () => {
    const { fail } = liveFailFromReceipt(program, {
      ok: true,
      tokenClass: "steered-skip",
      skipped: ["Bash"],
    });
    expect(fail?.kind).toBe("skipped");
    expect(fail?.detail).toMatch(/pr_summary/);
  });

  test("host-drop reason stays degraded with no step", () => {
    const { fail } = liveFailFromReceipt(program, {
      ok: 1,
      skipped: ["Read"],
      outcome: "degraded",
      reason: "The host dropped the rewrite (updatedToolOutput). Original tool output was kept.",
    });
    expect(fail?.kind).toBe("degraded");
    expect(fail?.step).toBeUndefined();
  });

  test("a passing live receipt with no tails is silent", () => {
    const { fail } = liveFailFromReceipt(program, { ok: 1, outcome: "ok" });
    expect(fail).toBeNull();
  });

  test("cache lookups forward onto the canvas receipt and stay omitted when absent", () => {
    const withCache = liveFailFromReceipt(program, { ok: 1, outcome: "ok", cache_lookups: 4, cache_hits: 3, cache_hit_rate: 0.75 });
    expect(withCache.receipt?.cache_lookups).toBe(4);
    expect(withCache.receipt?.cache_hits).toBe(3);
    expect(withCache.receipt?.cache_hit_rate).toBe(0.75);
    const silent = liveFailFromReceipt(program, { ok: 1, outcome: "ok" });
    expect(silent.receipt?.cache_lookups).toBeUndefined();
    expect(silent.receipt?.cache_hits).toBeUndefined();
  });

  test("tokenClasses and prompt+completion forward onto the canvas receipt; unmeasured omits them", () => {
    const classes = { compiled: 80, memoized: 0, transparent: 0, steeredSkip: 0, frontier: 20, providerCache: 5 };
    const measured = liveFailFromReceipt(program, {
      ok: 1,
      outcome: "ok",
      tokenClass: "compiled",
      tokenClasses: classes,
      prompt_tokens: 80,
      completion_tokens: 20,
    });
    expect(measured.receipt?.tokenClass).toBe("compiled");
    expect(measured.receipt?.tokenClasses).toEqual(classes);
    expect(measured.receipt?.prompt_tokens).toBe(80);
    expect(measured.receipt?.completion_tokens).toBe(20);
    const withProviderCache = liveFailFromReceipt(program, {
      ok: 1,
      outcome: "ok",
      prompt_tokens: 50,
      cached_tokens: 40,
      cache_write_tokens: 10,
      cache_input_tokens: 100,
    });
    expect(withProviderCache.receipt?.cached_tokens).toBe(40);
    expect(withProviderCache.receipt?.cache_write_tokens).toBe(10);
    expect(withProviderCache.receipt?.cache_input_tokens).toBe(100);
    const unmeasured = liveFailFromReceipt(program, { ok: 1, outcome: "ok", tokenClass: "steered-skip", skipped: ["Grep"] });
    expect(unmeasured.receipt?.tokenClasses).toBeUndefined();
    expect(unmeasured.receipt?.prompt_tokens).toBeUndefined();
    expect(unmeasured.receipt?.cached_tokens).toBeUndefined();
  });

  test("a queued replacement on the live tool uses the same words as the draft row", () => {
    const { fail } = liveFailFromReceipt(program, { ok: 0, outcome: "deopt", deoptReason: "envelope" }, { refreshWaiting: true });
    expect(fail?.kind).toBe("degraded");
    expect(fail?.detail).toMatch(/renamed a field/i);
    expect(fail?.next).toMatch(/unchanged until you Approve/i);
  });

  test("three receipts name Degraded even when the latest row is skip", () => {
    const now = 1_700_000_000_000;
    const { fail, stretchWords } = liveFailFromReceipt(program, [
      { created_at: now, ok: 1, tokenClass: "steered-skip", skipped: ["Grep"] },
      {
        created_at: now - 1000,
        ok: 1,
        outcome: "degraded",
        reason: "The host dropped the rewrite (updatedToolOutput). Original tool output was kept.",
      },
      { created_at: now - 2000, ok: 1, tokenClass: "transparent", outcome: "ok" },
    ]);
    expect(fail?.kind).toBe("skipped");
    expect(stretchWords).toEqual(["Served", "Skipped", "Degraded"]);
    expect(fail?.stretchWords).toEqual(["Served", "Skipped", "Degraded"]);
    expect(fail?.stretch).toMatch(/dropped the rewrite/i);
  });
});

describe("canvas origin warning offset", () => {
  test("null firstWarningAt is omitted — not call 0", () => {
    expect(canvasOrigin({ mode: "loop", firstWarningAt: 3 })).toEqual({ mode: "loop", firstWarningAt: 3 });
    expect(canvasOrigin({ mode: "fail_streak", firstWarningAt: 0 })).toEqual({ mode: "fail_streak", firstWarningAt: 0 });
    expect(canvasOrigin({ mode: "low_gain", firstWarningAt: null })).toEqual({ mode: "low_gain" });
    expect(canvasOrigin({ mode: "happy", firstWarningAt: 2 })).toBeUndefined();
    expect(canvasOrigin(null)).toBeUndefined();
  });
});
