import { describe, expect, test } from "bun:test";
import type { Trace } from "@eden/engine";
import { buildPartner } from "./build";
import { formatReport, traceReport } from "./trace-report";
import { StaticSource } from "@eden/sources";
import type { AgentEvent } from "@eden/protocol";

// D279: the integrator's self-check over an EDEN_TRACE=1 log.

const t = (x: Partial<Trace>): string =>
  JSON.stringify({
    sessionId: "s",
    turn: 1,
    event: "user_message",
    decision: "silent",
    reason: "no candidates",
    latencyMs: 10,
    sourceCalls: 1,
    modelCalls: 0,
    costUsd: 0,
    itemIds: [],
    ...x,
  });

describe("trace-report (D279)", () => {
  test("counts, silence reasons, percentiles and spend; other lines are skipped", () => {
    const lines = [
      "eden partner listening on http://127.0.0.1:8790 (dev, no auth)",
      JSON.stringify({ shadow: { sessionId: "s" } }),
      "not json {",
      JSON.stringify({ decision: "fast", sessionId: "s", latencyMs: 1, itemIds: [] }), // no reason: skipped
      t({}),
      t({ decision: "skipped", reason: "agent_message", sourceCalls: 0, latencyMs: 0 }),
      t({ decision: "sources", reason: "cue:1", itemIds: ["a"], latencyMs: 40, sourceCalls: 2 }),
      t({
        decision: "reader-push",
        reason: "cue:1",
        itemIds: ["a", "b"],
        latencyMs: 30,
        modelCalls: 1,
        costUsd: 0.0003,
      }),
      t({ decision: "silent", reason: "no model", sessionId: "s2", latencyMs: 20 }),
    ];
    const r = traceReport(lines);
    expect(r.traces).toBe(5);
    expect(r.sessionIds).toBe(2);
    expect(r.events).toBe(4); // the push is the user message's follow-up, not an event of its own
    expect(r.spoke).toBe(1); // the push is the same user message's: one event that spoke
    expect(r.silentReasons).toEqual({ "no candidates": 1, "no model": 1 });
    expect(r.latencyMs.silent).toEqual({ n: 2, p50: 10, p95: 20, p99: 20, max: 20 });
    expect(r.latencyMs.skipped).toBeUndefined();
    expect(r.sourceCallsPerEvent).toBe(1.25);
    expect(r.modelCalls).toBe(1);
    expect(r.costUsd).toBe(0.0003);
    expect(r.costUsdPer1kEvents).toBe(0.075);
    expect(formatReport(r)).toContain("spoke (items handed to the agent): 1 (25.0% of events)");
    expect(formatReport(traceReport([]))).toContain("EDEN_TRACE=1");
  });

  test("an update packet after a source notice is a follow-up, not an event (review of D279)", () => {
    const r = traceReport([
      t({ decision: "sources", reason: "cue:1", itemIds: ["a"] }),
      t({ decision: "sources", reason: "updated:inj_1", event: "source_change", turn: 1, itemIds: ["a"] }),
    ]);
    expect(r.events).toBe(1);
    expect(r.spoke).toBe(1); // a re-sent newer version is not a new event that spoke
  });

  test("each ask is an event of its own: asks move no turn, so (session, turn) does not tell them apart (audit A11)", () => {
    // An ask-only session (MCP) never observes, so every ask is turn 0; an agent also asks several times a request.
    const ask = (itemIds: string[]) => t({ event: "ask", decision: "answer", reason: "cue:1", turn: 0, itemIds });
    const r = traceReport([ask(["a"]), ask(["b"]), ask([]), ask(["c"])]);
    expect(r.events).toBe(4);
    expect(r.spoke).toBe(3);
  });

  test("an ask's follow-up packet (askBehind, D430) is a follow-up of that ask, not an event of its own", () => {
    const ask = t({ event: "ask", decision: "answer", reason: "cue:1", turn: 0, itemIds: ["a"] });
    const late = t({
      event: "ask",
      decision: "sources",
      reason: "ask behind",
      turn: 0,
      itemIds: ["b"],
      sourceCalls: 0,
    });
    const r = traceReport([ask, late]);
    expect(r.events).toBe(1);
    expect(r.spoke).toBe(1);
  });

  test("a push's background search of a cut copy (B1, D405) is a follow-up, not an event of its own", () => {
    const push = t({ decision: "sources", reason: "cue:1", itemIds: ["a"] });
    const behind = t({
      event: "search",
      decision: "skipped",
      reason: "cut search behind",
      itemIds: [],
      sourceCalls: 1,
    });
    const r = traceReport([push, behind]);
    expect(r.events).toBe(1);
  });

  test("a push and its second pass are their request's one event, whatever their order in the log (audit A11)", () => {
    const push = (itemIds: string[]) => t({ decision: "reader-push", reason: "cue:1", itemIds, candidates: true });
    const r = traceReport([push(["a"]), push(["a", "b"]), t({ decision: "silent", reason: "no candidates" })]);
    expect(r.events).toBe(1);
    expect(r.spoke).toBe(1);
  });

  test("reads what a real partner's onTrace writes", async () => {
    const lines: string[] = [];
    const crm = new StaticSource("crm", "deals", [
      { ref: "d1", title: "Globex renewal", text: "Dana Lee wants 12% off" },
    ]);
    const p = buildPartner({ sources: async () => [crm], model: null, onTrace: (x) => lines.push(JSON.stringify(x)) });
    const ev = (e: Record<string, unknown>) =>
      ({ tenantId: "t", userId: "u", sessionId: "s", at: Date.UTC(2026, 10, 7), ...e }) as AgentEvent;
    await p.observe(ev({ kind: "user_message", text: "Globex renewal with Dana Lee" }), { waitMs: 1_000 });
    await p.observe(ev({ kind: "agent_message", text: "One moment." }));
    p.stopSync();
    const r = traceReport(lines);
    expect(r.traces).toBe(lines.length);
    expect(r.events).toBeGreaterThanOrEqual(2);
    expect(r.spoke).toBeGreaterThan(0);
    expect(r.costUsd).toBe(0);
  });
});
