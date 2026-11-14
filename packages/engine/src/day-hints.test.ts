import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { monthDaysByPattern, monthDaysOf } from "./day-facts";
import { spanHinted, spanHintedByPattern } from "./days";

/*
 * D1916: `SPAN_HINT`'s month alternative and `MONTH_DAY` are tried only where a month's three letters start (at a
 * word boundary for `MONTH_DAY`), with sticky copies of the patterns, where each was tried at every position. The
 * patterns themselves are the reference: every answer must be theirs, on the eval's texts and on fuzzed strings
 * made of the shapes that decide where a match may start (a month's letters inside a word, after "_" or a digit,
 * full and short month names, ranges, years, connectors, ordinals, and matches that overlap a later month).
 */

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

function scenarioTexts(): string[] {
  const dir = new URL("../../eval/scenarios/", import.meta.url).pathname;
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.title === "string" && typeof o.text === "string") out.push(`${o.title}\n${o.text}`.toLowerCase());
      for (const x of Object.values(o)) walk(x);
    }
  };
  for (const f of new Bun.Glob("**/*.json").scanSync(dir)) walk(JSON.parse(readFileSync(`${dir}${f}`, "utf8")));
  return out;
}

const PIECES = [
  "jan", "january", "mar", "march", "may", "mayor", "summary", "june", "jun", "sept", "september", "dec", "decimal",
  "nov", "november", "oct", "_", "x", "2", "5", "12", "31", "2026", " ", "  ", "\n", ",", ".", "-", "–", "→", " to ",
  "until", " till ", "through", "thru", "up to", " the ", "5th", "1st", "of", "mon", "friday", "at least ", "é",
];

function fuzz(r: () => number): string {
  let s = "";
  const n = Math.floor(r() * 14);
  for (let k = 0; k < n; k++) s += PIECES[Math.floor(r() * PIECES.length)]!;
  return s;
}

describe("the month patterns at the months' starts (D1916) against the patterns tried everywhere", () => {
  test("the eval's texts", () => {
    for (const t of scenarioTexts()) {
      expect(spanHinted(t)).toBe(spanHintedByPattern(t));
      expect(monthDaysOf(t)).toEqual(monthDaysByPattern(t));
    }
  });

  test("fuzzed strings", () => {
    const r = rng(1916);
    const runs = Number(process.env.HINT_FUZZ ?? 60_000);
    for (let i = 0; i < runs; i++) {
      const s = fuzz(r);
      if (spanHinted(s) !== spanHintedByPattern(s)) throw new Error(`span hint differs on ${JSON.stringify(s)}`);
      const a = JSON.stringify(monthDaysOf(s));
      const b = JSON.stringify(monthDaysByPattern(s));
      if (a !== b) throw new Error(`month days differ on ${JSON.stringify(s)}: ${a} against ${b}`);
    }
  });
});
