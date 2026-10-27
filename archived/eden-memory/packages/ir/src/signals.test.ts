import { describe, expect, test } from "bun:test";
import { evidenceLedger, latestRepeatStalled, takeSignals } from "./signals";
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

  describe("progress-aware loop detection (waste audit W2)", () => {
    const budget = { duration_ms: 100, llmCalls: 3 };

    function named(name: string, result: unknown): TraceEvent {
      return { name, args: {}, result, ok: true };
    }

    test("a stalled interleaved loop still warns repeat_ngram", () => {
      const events = [
        named("get_ci_status", { state: "pending" }),
        named("sleep", {}),
        named("get_ci_status", { state: "pending" }),
        named("sleep", {}),
        named("get_ci_status", { state: "pending" }),
      ];
      const out = takeSignals(events, budget, new Set());
      expect(out.some((w) => w.kind === "repeat_ngram")).toBe(true);
    });

    test("polling that just watched the result change does not warn", () => {
      // CI flipped pending → success on the newest poll: the loop is paying
      // for itself. Warning here made the guard halt productive polls.
      const events = [
        named("get_ci_status", { state: "pending" }),
        named("sleep", {}),
        named("get_ci_status", { state: "pending" }),
        named("sleep", {}),
        named("get_ci_status", { state: "success" }),
      ];
      expect(takeSignals(events, budget, new Set())).toEqual([]);
    });

    test("pagination with changing arguments is not a loop", () => {
      const events = [
        named("list_rows", { page: 1 }),
        named("sleep", {}),
        named("list_rows", { page: 2 }),
        named("sleep", {}),
        named("list_rows", { page: 3 }),
      ];
      expect(
        takeSignals(
          events.map((e, i) => ({ ...e, args: { page: i === 0 ? 1 : i === 2 ? 2 : 3 } })),
          budget,
          new Set(),
        ),
      ).toEqual([]);
    });

    test("two identical polls still warn — indistinguishable from thrash yet", () => {
      const events = [
        named("get_ci_status", { state: "pending" }),
        named("sleep", {}),
        named("get_ci_status", { state: "pending" }),
        named("sleep", {}),
      ];
      const out = takeSignals(events, budget, new Set());
      expect(out.some((w) => w.kind === "repeat_ngram")).toBe(true);
    });

    test("latestRepeatStalled: identical repeats are stalled", () => {
      const events = [named("search", { hit: 1 }), named("write", { ok: true }), named("search", { hit: 1 })];
      expect(latestRepeatStalled(events, ["search", "write"])).toBe(true);
    });

    test("latestRepeatStalled: a changed result absolves the loop", () => {
      const events = [
        named("get_ci_status", { state: "pending" }),
        named("sleep", {}),
        named("get_ci_status", { state: "pending" }),
        named("sleep", {}),
        named("get_ci_status", { state: "success" }),
      ];
      expect(latestRepeatStalled(events, ["get_ci_status", "sleep"])).toBe(false);
    });

    test("latestRepeatStalled: changed inputs count as progress too", () => {
      const events = [
        { name: "read_file", args: { path: "a.ts" }, result: "x", ok: true },
        { name: "edit", args: {}, result: { ok: true }, ok: true },
        { name: "read_file", args: { path: "b.ts" }, result: "y", ok: true },
      ];
      expect(latestRepeatStalled(events, ["read_file", "edit"])).toBe(false);
    });

    test("latestRepeatStalled fails closed when results are unobservable", () => {
      // Two failures with no results: cannot tell progress from thrash.
      const events = [
        { name: "boom", args: {}, ok: false },
        { name: "boom", args: {}, ok: false },
      ];
      expect(latestRepeatStalled(events, ["boom"])).toBe(true);
    });

    test("timestamp drift on small results is spinning, not progress (probe)", () => {
      // One rotating field on a tiny result scored 0.83 overlap — above the
      // old 0.9-progress bar's inverse and enough to evade detection forever
      // when only args were checked. At most half shared tokens counts as
      // change; 0.83 does not clear it.
      const events = [
        named("update_issue", { id: 1, ts: "2026-01-01T00:00:00Z" }),
        named("sleep", {}),
        named("update_issue", { id: 1, ts: "2026-01-01T00:00:01Z" }),
        named("sleep", {}),
        named("update_issue", { id: 1, ts: "2026-01-01T00:00:02Z" }),
      ];
      const out = takeSignals(events, budget, new Set());
      expect(out.some((w) => w.kind === "repeat_ngram")).toBe(true);
    });

    test("argument jitter with constant results is spinning, not progress", () => {
      // Rotating a nonce argument while returning the same body must not buy
      // unbounded mutating cycles.
      const ev = (nonce: string): TraceEvent => ({
        name: "post_comment",
        args: { nonce },
        result: { ok: true },
        ok: true,
      });
      const sync = (): TraceEvent => ({ name: "sync", args: {}, result: { ok: true }, ok: true });
      const events = [ev("aaa"), sync(), ev("bbb"), sync(), ev("ccc")];
      expect(takeSignals(events, budget, new Set()).some((w) => w.kind === "repeat_ngram")).toBe(true);
    });
  });

  describe("spaced-spin detection (waste audit W2/W4)", () => {
    const budget = { duration_ms: 100, llmCalls: 3 };

    function call(name: string, args: Record<string, unknown>, result: unknown): TraceEvent {
      return { name, args, result, ok: true };
    }

    test("re-grepping variants that return nothing new is flagged", () => {
      // Different query terms, same empty-handed outcome — the pattern
      // adjacent-pair low_gain and contiguous repeat_ngram both miss.
      const events = [
        call("grep", { pattern: "foo" }, []),
        call("edit", {}, { ok: true }),
        call("grep", { pattern: "bar" }, []),
        call("write", {}, { ok: true }),
        call("grep", { pattern: "baz" }, []),
      ];
      const out = takeSignals(events, budget, new Set());
      expect(out.some((w) => w.kind === "repeat_visits")).toBe(true);
    });

    test("pagination and genuinely-new results are not flagged", () => {
      const events = [
        call("list_rows", { page: 1 }, { rows: [1] }),
        call("list_rows", { page: 2 }, { rows: [2] }),
        call("list_rows", { page: 3 }, { rows: [3] }),
      ];
      expect(takeSignals(events, budget, new Set()).some((w) => w.kind === "repeat_visits")).toBe(false);
    });

    test("fewer than three result-bearing calls never flags", () => {
      const events = [
        call("probe", {}, { state: "pending" }),
        call("other", {}, {}),
        call("probe", {}, { state: "pending" }),
      ];
      expect(takeSignals(events, budget, new Set()).some((w) => w.kind === "repeat_visits")).toBe(false);
    });

    test("failed calls do not count toward the visit run", () => {
      // Failures belong to fail_streak; a retry storm must not masquerade as
      // stalled reads (and vice versa).
      const events = [
        { name: "fetch", args: {}, ok: false },
        call("fetch", {}, { data: 1 }),
        { name: "fetch", args: {}, ok: false },
        call("fetch", {}, { data: 1 }),
      ];
      expect(takeSignals(events, budget, new Set()).some((w) => w.kind === "repeat_visits")).toBe(false);
    });
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

  test("a single event cannot warn when no required checks exist", () => {
    expect(takeSignals([ev("lookup")], { duration_ms: 1, llmCalls: 0 }, new Set())).toEqual([]);
    expect(takeSignals([ev("lookup", false)], { duration_ms: 1, llmCalls: 0 }, new Set())).toEqual([]);
  });

  test("two consecutive failures emit fail_streak plus a budget snapshot", () => {
    const seen = new Set<string>();
    const events = [ev("lookup", false), ev("write", false)];
    const budget = { duration_ms: 40, llmCalls: 2, prompt_tokens: 11, completion_tokens: 3 };
    const out = takeSignals(events, budget, seen);
    expect(out.map((w) => w.kind)).toEqual(["fail_streak", "budget"]);
    expect(out[0]).toMatchObject({
      at: 1,
      n: 2,
      duration_ms: 40,
      llmCalls: 2,
      prompt_tokens: 11,
      completion_tokens: 3,
    });
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
    const out = takeSignals(
      [ev("search"), ev("write"), ev("search"), ev("write")],
      { duration_ms: 9, llmCalls: 1 },
      seen,
    );
    expect(out.map((w) => w.kind)).toEqual(["repeat_ngram", "budget"]);
    expect(out[0]!.ngram).toEqual(["search", "write"]);
    expect(out[0]!.at).toBe(3);
  });

  test("the same tool three times in a row is a repeated n-gram", () => {
    // "tool_a" is not positively known to be a read, so the mutating/unknown
    // bar of 2 applies. A read-named tool gets READ_NGRAM_REPEAT_AT.
    const out = takeSignals([ev("tool_a"), ev("tool_a"), ev("tool_a")], { duration_ms: 2, llmCalls: 0 }, new Set());
    expect(out[0]!.kind).toBe("repeat_ngram");
    expect(out[0]!.ngram).toEqual(["tool_a", "tool_a"]);
  });

  test("an all-read loop gets one extra identical cycle before warning", () => {
    // Three consecutive get_status calls is what CI polling looks like; only
    // the fourth identical call counts as thrash. (W2, waste audit.)
    const quiet = takeSignals(
      [ev("get_status"), ev("get_status"), ev("get_status")],
      { duration_ms: 3, llmCalls: 1 },
      new Set(),
    );
    expect(quiet.some((w) => w.kind === "repeat_ngram")).toBe(false);
    const warned = takeSignals(
      [ev("get_status"), ev("get_status"), ev("get_status"), ev("get_status")],
      { duration_ms: 4, llmCalls: 1 },
      new Set(),
    );
    expect(warned.some((w) => w.kind === "repeat_ngram")).toBe(true);
  });

  test("a steered skip of a required check is not presence", () => {
    const events = [ev("writeRecord"), { name: "verifyWrite", args: {}, ok: true, skipped: true }, ev("notify")];
    const ledger = evidenceLedger(events, ["verifyWrite"]);
    expect(ledger.present).toEqual([]);
    expect(ledger.absent).toEqual(["verifyWrite"]);
  });
});
