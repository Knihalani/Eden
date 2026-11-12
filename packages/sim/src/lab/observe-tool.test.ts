import { describe, expect, test } from "bun:test";
import type { AgentEvent, Injection } from "@eden/protocol";
import { observeToolResult, type ToolObserver } from "./observe-tool";

const scope = { tenantId: "t", userId: "u", sessionId: "s" };
const event = { ...scope, at: 0, kind: "tool_result", tool: "search_gmail", output: "…" } as AgentEvent;
const packet: Injection = {
  ...scope,
  id: "inj-1",
  text: '<context src="the user\'s sources">\n- [gmail] Travel clinic: Thailand vaccines need 6 weeks\n</context>',
  citations: [{ itemId: "gmail:mail-1", sourceId: "gmail" }],
  mode: "proactive",
  reason: "push",
} as unknown as Injection;

/** A partner whose push packet was still pending when the tool ran: the tool result's observe hands it out. */
const handsOut = (injection: Injection | null): ToolObserver & { seen: AgentEvent[] } => {
  const seen: AgentEvent[] = [];
  return {
    seen,
    async observe(e) {
      seen.push(e);
      return { injection };
    },
  };
};

describe("observeToolResult (a harness reporting a tool result to Eden)", () => {
  test("a packet the observe hands out reaches the agent (it was dropped, F1)", async () => {
    const partner = handsOut(packet);
    const placed: Injection[] = [];
    const n = await observeToolResult(partner, event, (i) => placed.push(i));
    expect(partner.seen).toEqual([event]);
    expect(placed).toEqual([packet]);
    expect(n).toBe(1);
  });

  test("no packet: nothing is placed", async () => {
    const placed: Injection[] = [];
    expect(await observeToolResult(handsOut(null), event, (i) => placed.push(i))).toBe(0);
    expect(placed).toEqual([]);
  });
});
