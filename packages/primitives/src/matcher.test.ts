import { describe, expect, test } from "bun:test";
import { MultiMatcher } from "./matcher";
import { MultiMatcher as ReferenceMatcher } from "./matcher.reference";

const all = (m: MultiMatcher | ReferenceMatcher, text: string) => {
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
    const text = "zoe\u0301 said ZOË has a Token";
    expect(all(m, text).map(([p, s, e]) => [p, text.slice(s, e)])).toEqual([
      ["zoe", "zoe\u0301"], // the match extends over the trailing combining accent
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

  test("combining marks are part of the letter before them (review finding 3)", () => {
    const m = new MultiMatcher(["dana", "cafe"], { wholeWord: true });
    expect(all(m, "danáx édana")).toEqual([]);
    const text = "the cafe\u0301 is open";
    expect(all(m, text).map(([p, s, e]) => [p, text.slice(s, e)])).toEqual([["cafe", "cafe\u0301"]]);
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

/**
 * The transition table packed with its output bit (docs/research/redact-perf.md) and `scan`: `matcher.reference.ts`
 * is the matcher before them, kept unchanged as the oracle. Random texts over letters, the patterns' own characters,
 * case variants, combining marks, ligatures (one character that folds to several), final sigma and surrogates.
 */
describe("MultiMatcher against the reference, and scan", () => {
  const PIECES = [..."abcAB_-k :.", "́", "ﬁ", "ﬃ", "K", "ſ", "Σ", "😀", "é", "İ"];
  const prng = (seed: number) => {
    let x = seed >>> 0;
    return (n: number) => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) % n;
  };

  test("forEach, markHits and any agree with the reference matcher, whole-word or not", () => {
    const rnd = prng(11);
    const word = (len: number) => Array.from({ length: len }, () => PIECES[rnd(PIECES.length)]).join("");
    for (let set = 0; set < 30; set++) {
      const patterns = Array.from({ length: 1 + rnd(30) }, () => word(1 + rnd(5)));
      for (const wholeWord of [false, true]) {
        const now = new MultiMatcher(patterns, { wholeWord });
        const before = new ReferenceMatcher(patterns, { wholeWord });
        for (let round = 0; round < 40; round++) {
          const text = word(rnd(80));
          expect(all(now, text)).toEqual(all(before, text));
          const hits = [new Uint8Array(patterns.length), new Uint8Array(patterns.length)];
          expect(now.markHits(text, hits[0]!)).toBe(before.markHits(text, hits[1]!));
          expect([...hits[0]!]).toEqual([...hits[1]!]);
          expect(now.any(text)).toBe(before.any(text));
        }
      }
    }
  });

  test("scan reports markHits' hits, each first once, and forEach's start for every kept occurrence", () => {
    const rnd = prng(29);
    const word = (len: number) => Array.from({ length: len }, () => PIECES[rnd(PIECES.length)]).join("");
    for (let set = 0; set < 40; set++) {
      const patterns = Array.from({ length: 1 + rnd(30) }, () => word(1 + rnd(5)));
      const m = new MultiMatcher(patterns);
      const keep = Uint8Array.from(patterns, () => (rnd(3) === 0 ? 0 : 1));
      for (let round = 0; round < 40; round++) {
        const text = word(rnd(120));
        const hits = new Uint8Array(patterns.length);
        const expected = new Uint8Array(patterns.length);
        const firsts = new Int32Array(patterns.length);
        const kept: [number, number][] = [];
        const distinct = m.scan(text, hits, firsts, keep, { add: (p, start) => kept.push([p, start]) });
        expect(distinct).toBe(m.markHits(text, expected));
        expect([...hits]).toEqual([...expected]);
        expect([...firsts.subarray(0, distinct)].sort((a, b) => a - b)).toEqual(
          [...expected.keys()].filter((p) => expected[p] === 1),
        );
        const starts: [number, number][] = [];
        m.forEach(text, (p, start) => {
          if (keep[p] === 1) starts.push([p, start]);
        });
        expect(kept).toEqual(starts);
      }
    }
  });

  test("scan refuses a whole-word matcher", () => {
    const m = new MultiMatcher(["al"], { wholeWord: true });
    expect(() => m.scan("al", new Uint8Array(1), new Int32Array(1), new Uint8Array(1), { add: () => {} })).toThrow();
  });
});
