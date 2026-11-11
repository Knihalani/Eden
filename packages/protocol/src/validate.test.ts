import { describe, expect, test } from "bun:test";
import { itemId } from "./ids";
import { MAX_QUESTION_CHARS, bodyShapeUnder, checkAsk, checkEvent, checkSourceItems } from "./validate";

// A bound on work, not on waiting: process CPU time, so a loaded machine (four test files at once) does not
// fail it the way wall time did (weak-points-1111.md R1).
const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

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
    const t0 = cpuMs();
    const r = call(deep);
    const ms = cpuMs() - t0;
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

  test("333,000 empty objects (999,001 characters) are accepted", () => {
    expect(call(Array.from({ length: 333_000 }, () => ({}))).ok).toBe(true);
  });

  // `toJSON` returning [] makes the stringify cap pass, so only the node cap can refuse these, and the spy shows
  // whether stringify ran at all.
  const stringifiesTo = (input: object) => {
    const seen = { stringified: false };
    Object.defineProperty(input, "toJSON", {
      value: () => {
        seen.stringified = true;
        return [];
      },
    });
    return seen;
  };

  test("array elements count toward the 1,000,000-node cap; over it is refused before stringify", () => {
    const at = new Array(1_000_000).fill(0);
    const atSeen = stringifiesTo(at);
    expect(call(at).ok).toBe(true);
    expect(atSeen.stringified).toBe(true);
    const over = new Array(1_000_001).fill(0);
    const overSeen = stringifiesTo(over);
    expect(call(over).ok).toBe(false);
    expect(overSeen.stringified).toBe(false);
  });

  test("object values count as nodes, scalar or not; inherited and non-enumerable keys do not", () => {
    // n objects of one scalar each: n elements + n values.
    const objects = (n: number) => Array.from({ length: n }, (_, i) => ({ a: i }));
    const under = objects(500_000); // exactly 1,000,000 nodes
    stringifiesTo(under);
    expect(call(under).ok).toBe(true);
    const over = objects(500_001); // 1,000,002 nodes
    const overSeen = stringifiesTo(over);
    expect(call(over).ok).toBe(false);
    expect(overSeen.stringified).toBe(false);
    // An inherited enumerable key is not the object's own value, so it is not walked or counted.
    const proto = { inherited: new Array(1_000_001).fill(0) };
    const child = Object.create(proto) as Record<string, unknown>;
    child.own = 1;
    expect(call(child).ok).toBe(true);
    // Nor is a deep chain behind a non-enumerable key (stringify skips it too).
    const hidden = Object.defineProperty({}, "deep", { value: nest(1_001, (v) => [v]), enumerable: false });
    expect(call(hidden).ok).toBe(true);
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

describe("bodyShapeUnder: the raw body's values and depth before the parse", () => {
  const bytes = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
  test("every valid request passes: the widest and the deepest tool input checkEvent accepts", () => {
    const wide = { ...scope, kind: "tool_call", tool: "t", input: Array(499_990).fill(1) };
    expect(checkEvent(wide).ok).toBe(true);
    expect(bodyShapeUnder(bytes(wide))).toBe(true);
    let input: unknown = 1;
    for (let i = 0; i < 1_000; i++) input = [input];
    const deep = { ...scope, kind: "tool_call", tool: "t", input };
    expect(checkEvent(deep).ok).toBe(true);
    expect(bodyShapeUnder(bytes(deep))).toBe(true);
  });
  test("brackets, commas and escaped quotes inside strings are text, not structure", () => {
    const text = `"[{,\\" ${"[[[,,,{{{".repeat(200_000)}`;
    expect(bodyShapeUnder(bytes({ ...scope, kind: "user_message", text }))).toBe(true);
    expect(bodyShapeUnder(bytes({ text: 'ünïcødé 😀 \\\\"' }))).toBe(true);
  });
  test("past either bound it is refused", () => {
    expect(bodyShapeUnder(bytes(`{"x":${"[".repeat(1_009)}${"]".repeat(1_009)}}`))).toBe(false);
    expect(bodyShapeUnder(bytes({ x: Array(1_010_002).fill(0) }))).toBe(false);
    expect(bodyShapeUnder(bytes({ x: Array(1_000_000).fill(0) }))).toBe(true);
  });
});

describe("checkSourceItems", () => {
  test("makes ids from the source and ref, keeps only known fields, bounds the batch", () => {
    const ok = checkSourceItems({
      tenantId: "t",
      userId: "u",
      sourceId: "slack",
      items: [{ ref: "C1/123", text: "hello", extra: "dropped", meta: { channel: "general" } }],
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.items[0]).toEqual({
      id: itemId("slack", "C1/123"),
      sourceId: "slack",
      ref: "C1/123",
      title: "",
      text: "hello",
      meta: { channel: "general" },
    });
    expect(checkSourceItems({ tenantId: "t", userId: "u", sourceId: "slack", items: [{ ref: "r" }] }).ok).toBe(false);
    const updated = { tenantId: "t", userId: "u", sourceId: "s", items: [{ ref: "r", text: "x", updatedAt: "now" }] };
    expect(checkSourceItems(updated).ok).toBe(false);
  });
});

describe("an over-long field is refused with a message naming the limit, not a wrong reason", () => {
  const scope = { tenantId: "t", userId: "u", sessionId: "s" };
  const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);

  test("a question past MAX_QUESTION_CHARS says so; an empty one is still non-empty", () => {
    expect(errorOf(checkAsk({ ...scope, question: "q".repeat(MAX_QUESTION_CHARS + 1) }))).toBe(
      "question must be a string of at most 10,000 characters",
    );
    expect(errorOf(checkAsk({ ...scope, question: " " }))).toBe("question must be non-empty");
  });

  test("event text, tool and source past their limits name the limit", () => {
    const long = "x".repeat(1_000_001);
    expect(errorOf(checkEvent({ ...scope, kind: "user_message", text: long }))).toBe(
      "user_message.text must be a string of at most 1,000,000 characters",
    );
    expect(errorOf(checkEvent({ ...scope, kind: "tool_call", tool: "t".repeat(201), input: {} }))).toBe(
      "tool_call.tool must be a string of at most 200 characters",
    );
    expect(errorOf(checkEvent({ ...scope, kind: "tool_result", tool: "t", output: long }))).toBe(
      "tool_result needs tool (at most 200 characters) and output (at most 1,000,000) as strings",
    );
    expect(errorOf(checkEvent({ ...scope, kind: "external", source: "s".repeat(201), text: "x" }))).toBe(
      "external needs source (at most 200 characters) and text (at most 1,000,000) as strings",
    );
  });

  test("a pushed item's title or url that is not a string says so, as one past the limit does", () => {
    const base = { tenantId: "t", userId: "u", sourceId: "src" };
    expect(errorOf(checkSourceItems({ ...base, items: [{ ref: "r", text: "x", title: 5 }] }))).toBe(
      "items[0].title must be a string of at most 2,000 characters",
    );
    expect(errorOf(checkSourceItems({ ...base, items: [{ ref: "r", text: "x", url: "u".repeat(2_001) }] }))).toBe(
      "items[0].url must be a string of at most 2,000 characters",
    );
    expect(errorOf(checkSourceItems({ ...base, items: [{ ref: "r", text: "x".repeat(200_001) }] }))).toBe(
      "items[0].text must be a string of at most 200,000 characters",
    );
  });
});
