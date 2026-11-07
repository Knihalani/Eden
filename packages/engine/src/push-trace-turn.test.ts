import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { CORE_CONFIG } from "./parts";
import { ContextPartner } from "./partner";
import type { Trace } from "./trace";

// Audit A11: a push's trace names the turn of the request it read, not whatever turn the session reached by the time
// its lookup settled. `explain` (D277) shows the turn, and trace-report/digest (D279, D293) pair the push with its
// request's own trace by it: a later turn read as another event that spoke.

const NOW = Date.parse("2026-10-27T09:00:00Z");
const REQUEST = "Pay the Harlow invoice for the venue deposit today.";

const slow = (delayMs: number): Source => ({
  id: "mail",
  kind: "test",
  description: "mail",
  search: async () => {
    await Bun.sleep(delayMs);
    return [0, 1].map((i): ContextItem => ({
      id: `mail:${i}`,
      sourceId: "mail",
      ref: String(i),
      title: `Harlow invoice ${i}`,
      text: `Harlow venue deposit invoice ${i}: pay by Friday, not before the contract is signed.`,
      updatedAt: NOW - (i + 1) * 3_600_000,
    }));
  },
});

describe("a push's trace turn (audit A11)", () => {
  test("is its request's turn when the agent's events moved the session on during its lookup", async () => {
    const traces: Trace[] = [];
    const p = new ContextPartner({
      sources: async () => [slow(60)],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => NOW,
      // The candidates push (D237): no reader dependency, the default's push.
      config: { ...CORE_CONFIG, askReader: true, readerPush: true, pushCandidates: 5 },
      onTrace: (t) => traces.push(t),
    });
    const ref = { tenantId: "t", userId: "u", sessionId: "s" };
    const ev = (e: Record<string, unknown>) => ({ ...ref, at: NOW, ...e }) as AgentEvent;
    await p.observe(ev({ kind: "user_message", text: REQUEST }), { waitMs: 0 });
    // The agent works on while the push's search is on the wire: two more turns.
    await p.observe(ev({ kind: "agent_message", text: "Looking into it." }));
    await p.observe(ev({ kind: "tool_call", tool: "list_files", input: { dir: "." } }));
    for (let i = 0; i < 100 && !traces.some((t) => t.decision === "reader-push"); i++) await Bun.sleep(20);
    const push = traces.find((t) => t.decision === "reader-push");
    expect(push).toBeDefined();
    expect(push!.itemIds.length).toBeGreaterThan(0);
    expect(push!.turn).toBe(1);
    expect(p.explain(ref).find((t) => t.decision === "reader-push")!.turn).toBe(1);
  });
});
