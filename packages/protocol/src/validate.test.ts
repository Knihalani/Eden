import { describe, expect, test } from "bun:test";
import { itemId } from "./ids";
import {
  MAX_QUESTION_CHARS,
  bodyShapeQuick,
  bodyShapeUnder,
  bodyShapeWithin,
  checkAsk,
  checkEvent,
  checkSourceItems,
} from "./validate";

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
  // D1840: strings are crossed with `indexOf`. The byte loop it replaced is the oracle, at bounds small enough that
  // the seeded inputs reach them: strings short and long (past the 32-byte run), escapes dense and sparse, an escape
  // as the last byte, unended strings, non-ASCII, and structure on both sides of each.
  test("the same answer as the plain byte loop on seeded random bodies", () => {
    const loop = (b: Uint8Array, maxDepth: number, maxValues: number): boolean => {
      let depth = 0;
      let values = 0;
      let inString = false;
      for (let i = 0; i < b.length; i++) {
        const c = b[i]!;
        if (inString) {
          if (c === 0x5c) i++;
          else if (c === 0x22) inString = false;
          continue;
        }
        if (c === 0x22) inString = true;
        else if (c === 0x5b || c === 0x7b) {
          if (++depth > maxDepth || ++values > maxValues) return false;
        } else if (c === 0x5d || c === 0x7d) depth--;
        else if (c === 0x2c && ++values > maxValues) return false;
      }
      return true;
    };
    let seed = 1708;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      return (seed >>> 8) % n;
    };
    const pieces = ['"', "\\", '\\"', "[", "]", "{", "}", ",", "x", "é", " ", "1", ':"a"', "\\\\"];
    const run = (ch: string) => ch.repeat(1 + rand(80));
    let differ = 0;
    let refused = 0;
    let quickPassed = 0;
    for (let k = 0; k < 6_000; k++) {
      let text = "";
      const parts = 1 + rand(40);
      for (let p = 0; p < parts; p++)
        text += rand(4) === 0 ? run(pieces[rand(pieces.length)]!) : pieces[rand(pieces.length)]!;
      const b = new TextEncoder().encode(text);
      const maxDepth = 1 + rand(12);
      const maxValues = 1 + rand(16);
      const want = loop(b, maxDepth, maxValues);
      if (!want) refused++;
      if (bodyShapeWithin(b, maxDepth, maxValues) !== want) differ++;
      if (bodyShapeQuick(b, maxDepth, maxValues) !== want) differ++;
      // D1940's bracket count decides only where the body's bytes fit the value bound: give it such bounds too,
      // with depths up to past the body's brackets, so both of its answers (and its early give-up) are reached.
      const wide = rand(2) === 0 ? b.length + rand(4) : 1 + rand(b.length + 1);
      const deep = 1 + rand(rand(3) === 0 ? 200 : 40);
      const wanted = loop(b, deep, wide);
      if (bodyShapeQuick(b, deep, wide) !== wanted) differ++;
      if (wanted) quickPassed++;
    }
    // At the bracket count's own edges: every bracket nested outside strings (depth equals the count), and bodies
    // that are all structure (values equal the bytes), each at its bound, one under and one over.
    for (let d = 1; d <= 70; d++) {
      for (const open of ["[", "{"]) {
        const close = open === "[" ? "]" : "}";
        const nested = new TextEncoder().encode(open.repeat(d) + close.repeat(d));
        const flat = new TextEncoder().encode(`${open}${",".repeat(d)}`);
        for (const bound of [d - 1, d, d + 1]) {
          if (bodyShapeQuick(nested, bound, 1_000) !== loop(nested, bound, 1_000)) differ++;
          if (bodyShapeQuick(flat, 1_000, bound) !== loop(flat, 1_000, bound)) differ++;
          if (bodyShapeQuick(flat, 1, bound + 1) !== loop(flat, 1, bound + 1)) differ++;
        }
      }
    }
    expect(differ).toBe(0);
    expect(quickPassed).toBeGreaterThan(1_000);
    // Both answers occur often, so the comparison is not of one constant.
    expect(refused).toBeGreaterThan(400);
    expect(refused).toBeLessThan(5_000);
  });
  // D1840: the string scan's searches each move only forward. A version that searched for the next quote again on
  // every 32-byte run passed every test above and took over 60 s on a 1 MiB body of escapes (an independent review's
  // mutant); this guards the server and the router (D100), so each crafted 8 MiB body is bounded in CPU time.
  test("escape-heavy bodies stay linear: 8 MiB each under ~200 ms of CPU", () => {
    const size = 8 * 1024 * 1024;
    const fill = (unit: string, head = "", tail = "") => {
      const n = Math.floor((size - head.length - tail.length) / unit.length);
      return new TextEncoder().encode(head + unit.repeat(n) + tail);
    };
    const string35 = `"${"a".repeat(34)}\\n${"b".repeat(3)}",`; // 41 bytes and a comma; its escape at byte 35
    const bodies = {
      "a quote, then only backslashes": fill("\\", '"'),
      "escaped quotes and backslashes": fill('\\\\\\"', '"'),
      "an escape every 33 bytes, closed at the end": fill(`${"x".repeat(31)}\\n`, '"', '"'),
      "33-40-byte strings with an escape at byte 35": fill(string35, "["),
    };
    for (const [name, body] of Object.entries(bodies)) {
      expect(body.length).toBeGreaterThan(size - 64);
      const t0 = cpuMs();
      bodyShapeUnder(body);
      const ms = cpuMs() - t0;
      expect({ name, slow: ms > 200 }).toEqual({ name, slow: false });
    }
  });
});

// D1940: a tool call's input parsed from text of at most 1,000,000 / 6 characters skips its stringify, which rests on
// `JSON.stringify(JSON.parse(t))` never passing six times `t`'s length. The worst cases by hand, then seeded texts.
describe("checkEvent's source length: the stringify it skips", () => {
  const grows = (t: string) => JSON.stringify(JSON.parse(t)).length / t.length;
  test("no text's JSON grows past six times its length", () => {
    const worst = [
      "1e20",
      "9e20",
      "-1e20",
      "1E+20",
      "[1e20,1e20]",
      "1e-6",
      "1e21",
      `"\ud800"`,
      `"${"\udc00".repeat(99)}"`,
    ];
    for (const t of worst) expect({ t, over: grows(t) > 6 }).toEqual({ t, over: false });
    let seed = 1940;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      return (seed >>> 8) % n;
    };
    const atoms = ["1e20", "0", "-0", "1e-7", "1.5e19", "123456789012345678901234", "true", "null", '"\\u0041"'];
    atoms.push('"\\n"', '"\\/"', `"\ud83d"`, `"é"`, '"\\ud800"', '"x"', "1e400", "0.000001", "12e18");
    const value = (d: number): string => {
      const r = rand(10);
      if (d > 4 || r < 5) return atoms[rand(atoms.length)]!;
      const n = rand(6);
      const parts = Array.from({ length: n }, () => value(d + 1));
      if (r < 7) return `[${parts.join(rand(2) ? "," : " , ")}]`;
      return `{${parts.map((p) => `"${"ab"[rand(2)]}" : ${p}`).join(",")}}`;
    };
    let max = 0;
    for (let k = 0; k < 20_000; k++) max = Math.max(max, grows(value(0)));
    expect(max).toBeLessThanOrEqual(6);
    expect(max).toBeGreaterThan(4); // the generator reaches the bound's neighbourhood
  });
  test("the same answer with and without the source length", () => {
    const input = (n: number) => ({ path: "a.ts", content: "x\n".repeat(n), n: 1e20 });
    for (const n of [0, 10, 80_000, 600_000]) {
      const text = JSON.stringify({ ...scope, at: 1, kind: "tool_call", tool: "write", input: input(n) });
      const plain = checkEvent(JSON.parse(text));
      expect(checkEvent(JSON.parse(text), text.length)).toEqual(plain);
    }
    // Short numbers that grow past the bound (230,000 characters, about 1,012,000 as JSON): refused either way, so the
    // skip's threshold cannot be raised past a sixth unnoticed.
    const grown = `{"tenantId":"acme","userId":"u_1","sessionId":"s_1","at":1,"kind":"tool_call","tool":"t",
      "input":[${"1e20,".repeat(46_000)}1e20]}`;
    expect(checkEvent(JSON.parse(grown)).ok).toBe(false);
    expect(checkEvent(JSON.parse(grown), grown.length).ok).toBe(false);
    // Deep input is still refused by the walk, whatever the length.
    let deep: unknown = 1;
    for (let i = 0; i < 1_001; i++) deep = [deep];
    const text = JSON.stringify({ ...scope, kind: "tool_call", tool: "t", input: deep });
    expect(checkEvent(JSON.parse(text), text.length).ok).toBe(false);
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
    // A non-epoch updatedAt is coerced (ISO, epoch digits, seconds) or dropped, never rejected (A4).
    const updated = { tenantId: "t", userId: "u", sourceId: "s", items: [{ ref: "r", text: "x", updatedAt: "now" }] };
    const coerced = checkSourceItems(updated);
    expect(coerced.ok).toBe(true);
    if (coerced.ok) expect(coerced.value.items[0]!.updatedAt).toBeUndefined();
    const iso = checkSourceItems({
      tenantId: "t",
      userId: "u",
      sourceId: "s",
      items: [{ ref: "r", text: "x", updatedAt: "2026-11-23T10:00:00Z" }],
    });
    expect(iso.ok && iso.value.items[0]!.updatedAt).toBe(Date.parse("2026-11-23T10:00:00Z"));
    const secs = checkSourceItems({
      tenantId: "t",
      userId: "u",
      sourceId: "s",
      items: [{ ref: "r", text: "x", updatedAt: "1763911200" }],
    });
    expect(secs.ok && secs.value.items[0]!.updatedAt).toBe(1_763_911_200_000);
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

  test("a pushed item's odd fields are trimmed and coerced, never rejected (A4)", () => {
    const base = { tenantId: "t", userId: "u", sourceId: "src" };
    const coerced = checkSourceItems({
      ...base,
      items: [
        {
          ref: "r",
          text: 42 as unknown as string,
          title: "t".repeat(3_000),
          url: "u".repeat(2_001),
          meta: { a: 7, b: true, deep: { x: 1 }, long: "v".repeat(3_000) },
        },
      ],
    });
    expect(coerced.ok).toBe(true);
    if (coerced.ok) {
      const it = coerced.value.items[0]!;
      expect(it.text).toBe("42");
      expect(it.title).toHaveLength(2_000);
      expect(it.url).toBeUndefined();
      expect(it.meta).toEqual({ a: "7", b: "true", long: "v".repeat(2_000) });
    }
    const huge = checkSourceItems({ ...base, items: [{ ref: "r", text: "x".repeat(200_001) }] });
    expect(huge.ok && huge.value.items[0]!.text.length).toBe(200_000);
  });
});
