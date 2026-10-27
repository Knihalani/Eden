import { describe, expect, test } from "bun:test";
import { murmur3, fnv1a, mix32 } from "./hash";
import { tokenize, tokenizeInto } from "./tokenize";
import { Vocab } from "./vocab";

describe("tokenize", () => {
  test("folds case and accents, strips possessives and trailing punctuation, drops one-char terms", () => {
    const v = new Vocab();
    expect(tokenize("Dana’s renewal-- for ZOË, Zoe's and Müller's a b", v)).toEqual([
      "dana",
      "renewal",
      "for",
      "zoe",
      "zoe",
      "and",
      "muller",
    ]);
  });

  test("keeps internal apostrophes, hyphens, underscores and digits; ids are shared across spellings", () => {
    const v = new Vocab();
    expect(tokenize("don't OPS-142 snake_case 2026-11-30", v)).toEqual([
      "don't",
      "ops-142",
      "snake_case",
      "2026-11-30",
    ]);
    expect(v.lookup("Ops-142")).toBe(v.lookup("ops-142"));
    expect(v.lookup("café")).toBe(-1);
    expect(v.intern("Café")).toBe(v.lookup("cafe"));
  });

  test("ligatures take the slow path and still fold ('ﬁnal' is 'final')", () => {
    const v = new Vocab();
    expect(tokenize("ﬁnal final", v)).toEqual(["final", "final"]);
    expect(v.size).toBe(1);
  });

  test("emoji separate terms; CJK runs are one term", () => {
    const v = new Vocab();
    expect(tokenize("ship🚀it 東京 ok", v)).toEqual(["ship", "it", "東京", "ok"]);
  });

  test("query mode skips unknown terms and reports offsets", () => {
    const v = new Vocab();
    tokenize("globex renewal", v);
    const out = new Uint32Array(8);
    const starts = new Uint32Array(8);
    const n = tokenizeInto("The Globex renewal, again", v, false, out, starts);
    expect([...out.subarray(0, n)].map((id) => v.term(id))).toEqual(["globex", "renewal"]);
    expect([...starts.subarray(0, n)]).toEqual([4, 11]);
  });

  test("respects the output capacity", () => {
    const v = new Vocab();
    const out = new Uint32Array(2);
    expect(tokenizeInto("one two three four", v, true, out, null)).toBe(2);
  });
});

describe("Vocab", () => {
  test("ids are dense and stable through growth; range and string paths agree", () => {
    const v = new Vocab(4);
    const words = Array.from({ length: 5_000 }, (_, i) => `w${i}x`);
    const ids = words.map((w) => v.intern(w));
    expect(ids).toEqual(words.map((_, i) => i));
    expect(words.every((w, i) => v.lookup(w.toUpperCase()) === i)).toBe(true);
    const out = new Uint32Array(words.length);
    expect(tokenizeInto(words.join(" "), v, false, out, null)).toBe(words.length);
    expect([...out]).toEqual(ids);
  });
});

describe("hash", () => {
  test("murmur3 matches the reference vectors", () => {
    const enc = new TextEncoder();
    const m = (s: string, seed: number) => murmur3(enc.encode(s), seed, 0, enc.encode(s).length);
    expect(m("", 0)).toBe(0);
    expect(m("", 1)).toBe(0x514e28b7);
    expect(m("hello", 0)).toBe(0x248bfa47);
    expect(m("The quick brown fox jumps over the lazy dog", 0)).toBe(0x2e4ff723);
  });

  test("fnv1a matches the reference vector and mix32 is a bijection on samples", () => {
    expect(fnv1a("a", 0, 1)).toBe(0xe40c292c);
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i++) seen.add(mix32(i));
    expect(seen.size).toBe(10_000);
  });
});
