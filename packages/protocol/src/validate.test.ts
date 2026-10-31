import { describe, expect, test } from "bun:test";
import { checkAsk, checkEvent } from "./validate";

const scope = { tenantId: "acme", userId: "u_1", sessionId: "s_1" };

describe("checkEvent", () => {
  test("accepts each event kind and fills a missing timestamp", () => {
    const r = checkEvent({ ...scope, kind: "user_message", text: "what's on tomorrow?" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.at).toBeGreaterThan(0);
    expect(checkEvent({ ...scope, kind: "tool_result", tool: "gmail.search", output: "[]" }).ok).toBe(true);
    expect(checkEvent({ ...scope, kind: "external", source: "gmail", text: "New mail from Dana" }).ok).toBe(true);
  });

  test("a user message is a draft only when draft is true; an agent message never is", () => {
    const d = checkEvent({ ...scope, kind: "user_message", text: "move my lunch with", draft: true });
    expect(d.ok && d.value.kind === "user_message" && d.value.draft).toBe(true);
    for (const draft of ["true", 1, false, null]) {
      const r = checkEvent({ ...scope, kind: "user_message", text: "hi", draft });
      expect(r.ok && "draft" in r.value).toBe(false);
    }
    const a = checkEvent({ ...scope, kind: "agent_message", text: "hi", draft: true });
    expect(a.ok && "draft" in a.value).toBe(false);
  });

  test("rejects unknown kinds, bad ids and missing text with a message", () => {
    expect(checkEvent({ ...scope, kind: "nope" })).toEqual({ ok: false, error: "unknown event kind: nope" });
    expect(checkEvent({ ...scope, tenantId: "a b", kind: "session_end" }).ok).toBe(false);
    expect(checkEvent({ ...scope, kind: "user_message" }).ok).toBe(false);
    expect(checkEvent(null).ok).toBe(false);
  });
});

describe("checkAsk", () => {
  test("clamps maxItems and rejects an empty question", () => {
    const r = checkAsk({ ...scope, question: "who is Dana?", maxItems: 99 });
    expect(r.ok && r.value.maxItems).toBe(20);
    expect(checkAsk({ ...scope, question: "  " }).ok).toBe(false);
  });
});

test("tool_call.input must serialize to JSON under 1,000,000 characters", () => {
  const scope = { tenantId: "t", userId: "u", sessionId: "s" };
  expect(checkEvent({ ...scope, kind: "tool_call", tool: "t", input: { q: "x" } }).ok).toBe(true);
  expect(checkEvent({ ...scope, kind: "tool_call", tool: "t", input: "x".repeat(1_000_001) }).ok).toBe(false);
  let deep: unknown = 1;
  for (let i = 0; i < 60_000; i++) deep = [deep];
  expect(checkEvent({ ...scope, kind: "tool_call", tool: "t", input: deep }).ok).toBe(false);
});
