import { describe, expect, test } from "bun:test";
import { truncateUtf8, utf8Length } from "./utf8";

const enc = new TextEncoder();

describe("utf8", () => {
  test("length matches TextEncoder, including astral and lone surrogates", () => {
    for (const s of ["", "abc", "zoë", "東京", "🚀x", "a\ud800b", "\udc00"])
      expect(utf8Length(s)).toBe(enc.encode(s).length);
  });

  test("truncation is the longest fitting prefix and never splits a pair", () => {
    let x = 5;
    const rnd = (n: number) => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) % n;
    const parts = ["a", "é", "東", "🚀", "\ud800", " "];
    for (let round = 0; round < 2_000; round++) {
      const s = Array.from({ length: rnd(40) }, () => parts[rnd(parts.length)]).join("");
      const max = rnd(60);
      const t = truncateUtf8(s, max);
      expect(s.startsWith(t)).toBe(true);
      expect(enc.encode(t).length).toBeLessThanOrEqual(max);
      // Longest: adding the next whole character (pair-aware) would not fit.
      if (t.length < s.length) {
        const next = s.codePointAt(t.length)! > 0xffff ? 2 : 1;
        expect(enc.encode(s.slice(0, t.length + next)).length).toBeGreaterThan(max);
      }
      // Never ends on a high surrogate whose pair was cut.
      const last = t.charCodeAt(t.length - 1);
      if (last >= 0xd800 && last <= 0xdbff)
        expect(s.charCodeAt(t.length) >= 0xdc00 && s.charCodeAt(t.length) <= 0xdfff).toBe(false);
    }
  });
});
