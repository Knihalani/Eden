import { describe, expect, test } from "bun:test";
import { MultiMatcher } from "./matcher";

const all = (m: MultiMatcher, text: string) => {
  const out: [string, number, number][] = [];
  m.forEach(text, (p, s, e) => out.push([m.patterns[p]!, s, e]));
  return out;
};

describe("MultiMatcher", () => {
  test("finds overlapping patterns (the classic he/she/his/hers case) with offsets", () => {
    const m = new MultiMatcher(["he", "she", "his", "hers"]);
    expect(all(m, "ushers")).toEqual([
      ["she", 1, 4],
      ["he", 2, 4],
      ["hers", 2, 6],
    ]);
  });

  test("folds case and accents in both patterns and text, keeping original offsets", () => {
    const m = new MultiMatcher(["Zoë", "TOKEN"]);
    const text = "zoé said ZOË has a Token";
    expect(all(m, text).map(([p, s, e]) => [p, text.slice(s, e)])).toEqual([
      ["zoe", "zoé".slice(0, 3)],
      ["zoe", "ZOË"],
      ["token", "Token"],
    ]);
  });

  test("wholeWord skips matches inside words", () => {
    const m = new MultiMatcher(["al", "bring", "dana"], { wholeWord: true });
    expect(all(m, "also ask Al to bring-it, bringing Dana's")).toEqual([
      ["al", 9, 11],
      ["bring", 15, 20],
      ["dana", 34, 38],
    ]);
  });

  test("any stops early; markHits counts distinct patterns", () => {
    const m = new MultiMatcher(["api_key", "secret", "token"]);
    expect(m.any("nothing here")).toBe(false);
    expect(m.any("my SECRET")).toBe(true);
    const hits = new Uint8Array(3);
    expect(m.markHits("token secret token", hits)).toBe(2);
    expect([...hits]).toEqual([0, 1, 1]);
  });

  test("agrees with a naive lowercase includes scan on random ASCII text", () => {
    let x = 7;
    const rnd = (n: number) => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) % n;
    const alphabet = "abcAB_-";
    const word = (len: number) => Array.from({ length: len }, () => alphabet[rnd(alphabet.length)]).join("");
    const patterns = Array.from({ length: 40 }, () => word(1 + rnd(4)));
    const m = new MultiMatcher(patterns);
    for (let round = 0; round < 200; round++) {
      const text = word(60);
      const hits = new Uint8Array(patterns.length);
      m.markHits(text, hits);
      const lower = text.toLowerCase();
      expect([...hits]).toEqual(patterns.map((p) => (lower.includes(p.toLowerCase()) ? 1 : 0)));
    }
  });
});
