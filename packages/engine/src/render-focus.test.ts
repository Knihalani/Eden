import { describe, expect, test } from "bun:test";
import { focusCount, focusWordsOf, wordsIn } from "./render";
import { readWordUnit, WORD_UNITS } from "./text";

/*
 * D1910: `pick`'s focus count searches each focus word with `indexOf` and checks its neighbours, where D1884 scanned
 * the part's words one code unit at a time. `focusCountScan` is D1884's function verbatim (the oracle); every count
 * here must be its count, on fuzzed parts and focus sets built from the shapes either side reads: repeated and
 * overlapping words ("aa" in "aaa"), a focus word inside a longer word, at the string's ends, beside digits and
 * punctuation, accented and non-Latin letters, combining marks, astral letters and lone surrogates, and focus strings
 * no word can equal (empty, with a space or a hyphen, an astral letter).
 */

function focusCountScan(s: string, focus: readonly string[]): number {
  let n = 0;
  let start = -1;
  for (let i = 0; i <= s.length; i++) {
    const c = i < s.length ? s.charCodeAt(i) : 32;
    let k = WORD_UNITS[c]!;
    if (k === 0 && (k = readWordUnit(c)) === 0) {
      let m = 0;
      for (const w of wordsIn(s)) if (focus.includes(w)) m++;
      return m;
    }
    if (k === 1) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const len = i - start;
      for (let f = 0; f < focus.length; f++) {
        const w = focus[f]!;
        if (w.length === len && s.startsWith(w, start)) {
          n++;
          break;
        }
      }
      start = -1;
    }
  }
  return n;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["a", "aa", "aaa", "ab", "ba", "kim", "kimberly", "garcía", "garcia", "renewal", "2026", "x1", "東京", "ß"];
const ODD = ["", "a b", "kim-lee", "😀", "𝒜bc", "x́", "-", "\uD800"];
const GLUE = [" ", "  ", ", ", ".", "-", "'", "’", "\n", "\t", "/", "@", "_", "́", "😀", "\uDC00", "1", "é"];

function fuzzCase(r: () => number): { s: string; focus: string[] } {
  const pickOf = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  let s = "";
  const n = Math.floor(r() * 14);
  for (let i = 0; i < n; i++) {
    const roll = r();
    s += roll < 0.75 ? pickOf(WORDS) : pickOf(ODD);
    // Mostly a plain separator; sometimes glue that joins two words or adds a surrogate.
    s += r() < 0.7 ? " " : pickOf(GLUE);
  }
  if (r() < 0.5) s = s.trimEnd();
  const focus = new Set<string>();
  const f = Math.floor(r() * 7);
  for (let i = 0; i < f; i++) focus.add(r() < 0.8 ? pickOf(WORDS) : pickOf(ODD));
  return { s, focus: [...focus] };
}

describe("focusCount (D1910) against D1884's scan", () => {
  test("fixed cases", () => {
    const cases: [string, string[], number][] = [
      ["kim kim kimberly", ["kim"], 2],
      ["aaa aa a", ["aa", "a"], 2],
      ["aaaa", ["aa"], 0],
      ["kim,kim.kim", ["kim"], 3],
      ["garcía garcia", ["garcía"], 1],
      ["x1 1x x1", ["x1"], 2],
      ["kim-lee kim", ["kim-lee", "kim"], 2],
      ["😀kim kim", ["kim"], 2],
      ["𝒜bc kim", ["𝒜bc", "kim"], 2],
      ["", ["kim"], 0],
      ["kim", [], 0],
      ["kim", [""], 0],
    ];
    for (const [s, focus, want] of cases) {
      expect(focusCountScan(s, focus)).toBe(want);
      expect(focusCount(s, focusWordsOf(focus), focus)).toBe(want);
    }
  });

  test("fuzzed parts and focus sets", () => {
    const r = rng(1910);
    const runs = Number(process.env.FOCUS_FUZZ ?? 40_000);
    for (let i = 0; i < runs; i++) {
      const { s, focus } = fuzzCase(r);
      const want = focusCountScan(s, focus);
      const got = focusCount(s, focusWordsOf(focus), focus);
      if (got !== want) throw new Error(`case ${i}: ${JSON.stringify({ s, focus, want, got })}`);
    }
  });

  test("random code units", () => {
    const r = rng(7);
    for (let i = 0; i < 5_000; i++) {
      let s = "";
      const len = Math.floor(r() * 40);
      for (let j = 0; j < len; j++) s += String.fromCharCode(r() < 0.6 ? 97 + Math.floor(r() * 3) : r() * 0x10000);
      const focus = [...new Set(wordsIn(s).slice(0, 3).concat(["a", "ab"]))];
      expect(focusCount(s, focusWordsOf(focus), focus)).toBe(focusCountScan(s, focus));
    }
  });
});
