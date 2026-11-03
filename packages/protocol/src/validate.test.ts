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
});

describe("tool_call.input depth and size (D100)", () => {
  const scope = { tenantId: "t", userId: "u", sessionId: "s" };
  const nest = (depth: number, wrap: (v: unknown) => unknown): unknown => {
    let v: unknown = 1;
    for (let i = 0; i < depth; i++) v = wrap(v);
    return v;
  };
  const call = (input: unknown) => checkEvent({ ...scope, kind: "tool_call", tool: "t", input });

  test("a 60,000-deep input is refused before any stringify, in well under a second", () => {
    const deep = nest(60_000, (v) => [v]);
    const t0 = performance.now();
    const r = call(deep);
    const ms = performance.now() - t0;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/1,000 deep/);
    // Stringifying until the stack overflowed took ~1.5 s here; the walk stops at the cap. Loose bound for slow CI.
    expect(ms).toBeLessThan(500);
  });

  test("depth 100 and depth 1,000 are accepted; 1,001 is refused, for arrays and objects alike", () => {
    expect(call(nest(100, (v) => [v])).ok).toBe(true);
    expect(call(nest(1_000, (v) => [v])).ok).toBe(true);
    expect(call(nest(1_000, (v) => ({ a: v }))).ok).toBe(true);
    expect(call(nest(1_001, (v) => [v])).ok).toBe(false);
    expect(call(nest(1_001, (v) => ({ a: v }))).ok).toBe(false);
    // Depth is measured along the deepest branch, not summed across siblings.
    expect(call({ a: nest(999, (v) => [v]), b: nest(999, (v) => ({ c: v })) }).ok).toBe(true);
  });

  test("scalars, null and a missing input pass; the length cap still applies after the walk", () => {
    for (const input of [undefined, null, 0, "x", true, [], {}]) expect(call(input).ok).toBe(true);
    expect(call({ q: "x".repeat(1_000_001) }).ok).toBe(false);
    expect(call(Array.from({ length: 300_000 }, () => 1)).ok).toBe(true); // 600,001 characters
    expect(call(Array.from({ length: 600_000 }, () => 1)).ok).toBe(false); // 1,200,001 characters
  });

  test("an embedder's cyclic or throwing input is refused, never thrown", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(call(cyclic).ok).toBe(false);
    const throwing = Object.defineProperty({}, "a", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(() => call(throwing)).not.toThrow();
    expect(call(throwing).ok).toBe(false);
  });
});
