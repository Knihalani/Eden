import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sketchTableClear, sketchTableSlots, sketchTerms, sketchTermsSplit, TABLE_MAX_CHARS } from "./sketch";
import {
  extractTypedEntities,
  fnvOfWord,
  isCalendar,
  isCalendarByPattern,
  isStopword,
  STOP_FNV,
  stopwordAt,
  type Entity,
} from "./text";

/*
 * D1886: the sync's per-item readings by code unit. `sketchTerms` scans the lower-cased text once (the split is kept as
 * `sketchTermsSplit`, also its reading of a text with a surrogate); `isCalendar` reads a word's ending by code unit
 * (the pattern reading is kept as `isCalendarByPattern`); `extractTypedEntities` runs a pattern only where the text
 * holds the character it needs (its reading before is copied below). Each must give its reference's output.
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

/** `extractTypedEntities` before D1886, unchanged but for the shared `isCalendarByPattern` and stopword test. */
function entitiesBefore(text: string): Entity[] {
  const found = new Map<string, Entity>();
  const add = (s: string | undefined, kind: Entity["kind"]) => {
    const v = s?.trim();
    if (v && v.length > 1 && v.length <= 80 && !found.has(v)) found.set(v, { text: v, kind });
  };
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) add(m[0], "email");
  for (const m of text.matchAll(/(?:^|\s)@([A-Za-z0-9_][\w.-]{1,40})/g)) add(m[1], "handle");
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g)) add(m[0], "id");
  for (const m of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) add(m[0], "url");
  for (const m of text.matchAll(/["“]([^"”\n]{3,60})["”]/g)) add(m[1], "quoted");
  for (const m of text.matchAll(/(^|[.!?]\s+|\s)((?:\p{Lu}[\p{L}&'-]+)(?:\s+\p{Lu}[\p{L}&'-]+)*)/gu)) {
    const sentenceStart = m[1] === "" || /[.!?]/.test(m[1]!);
    let words = m[2]!.split(/\s+/);
    let from = 0;
    let to = words.length;
    while (from < to && isCalendarByPattern(words[from]!)) from++;
    while (to > from && isCalendarByPattern(words[to - 1]!)) to--;
    if (to === from) continue;
    if (to - from >= 2) words = words.slice(from, to);
    // Same lone-honorific skip as extractTypedEntities ("Dr" of "Dr. Okafor" is no name).
    if (words.length === 1 && "dr mr mrs ms miss prof sir madam rev st".split(" ").includes(words[0]!.toLowerCase()))
      continue;
    // Same leading-auxiliary cut (D2097): "Did HMRC…" names HMRC.
    let auxCut = false;
    if (
      sentenceStart &&
      words.length >= 2 &&
      (
        "do does did is are was were has have had can could should would may might must shall ought " +
        "tell send ask ping remind reply respond invite notify congratulate introduce pay buy cancel reschedule " +
        "write add approve accept decline confirm"
      )
        .split(" ")
        .includes(words[0]!.toLowerCase())
    ) {
      words = words.slice(1);
      auxCut = true;
    }
    const run = words.join(" ");
    if (words.length === 1 && (sentenceStart || isStopword(run.toLowerCase()) || isCalendarByPattern(run)) && !auxCut)
      continue;
    if (words.every((w) => isStopword(w.toLowerCase()))) continue;
    add(run, "name");
  }
  return [...found.values()];
}

const PIECES = [
  "Sunday",
  "SUNDAYS",
  "Sunday's",
  "sunday’S",
  "Sunday-morning",
  "Mondays-",
  "-Tue",
  "Wednesday's",
  "Weds",
  "Dec",
  "December's",
  "Mars",
  "May",
  "Jun",
  "İnan",
  "Mon-Fri",
  "TUESDAYS's",
  "Dana Lee",
  "dana@acme.com",
  "@robin_c",
  "OPS-412",
  "https://x.y/z?a=1",
  '"the big launch"',
  "“quoted words”",
  "Zoë Müller",
  "Łukasz Kraków",
  "会议",
  "🎉 party",
  "the",
  "What We",
  "It Is",
  "on Friday Dana Lee",
  "Sunday Times",
  "3rd",
  "ab",
  "x1y2z3",
  "naïve café",
  "ΣΟΦΙΑ",
  "Straße",
  ".",
  "!",
  "\n",
];
const SEPS = [" ", ". ", "\n", ", ", "-", "", "  "];

function sentence(r: () => number): string {
  const n = 1 + Math.floor(r() * 12);
  let out = "";
  for (let i = 0; i < n; i++) out += PIECES[Math.floor(r() * PIECES.length)]! + SEPS[Math.floor(r() * SEPS.length)]!;
  return out;
}

/** Random code units: ASCII, Latin-1, the rest of the BMP, and surrogates, so every class is met. */
function units(r: () => number): string {
  let s = "";
  const n = Math.floor(r() * 30);
  for (let i = 0; i < n; i++) {
    const x = r();
    s += String.fromCharCode(
      x < 0.6
        ? 32 + Math.floor(r() * 95)
        : x < 0.8
          ? 0x80 + Math.floor(r() * 0x180)
          : x < 0.95
            ? Math.floor(r() * 0xd800)
            : 0xd800 + Math.floor(r() * 0x800),
    );
  }
  return s;
}

/** Every item text in the eval's scenarios. */
function scenarioTexts(): string[] {
  const dir = new URL("../../eval/scenarios/", import.meta.url).pathname;
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.title === "string" && typeof o.text === "string") out.push(`${o.title}. ${o.text}`);
      for (const x of Object.values(o)) walk(x);
    }
  };
  for (const f of new Bun.Glob("**/*.json").scanSync(dir)) walk(JSON.parse(readFileSync(`${dir}${f}`, "utf8")));
  return out;
}

describe("the sync's readings by code unit (D1886) against their references", () => {
  test("isCalendar: every piece, fuzzed words and random code units", () => {
    const r = rng(18861);
    const words = [...PIECES];
    for (let i = 0; i < 20_000; i++) words.push(r() < 0.5 ? sentence(r).split(/\s+/)[0]! : units(r));
    let dates = 0;
    for (const w of words) {
      const want = isCalendarByPattern(w);
      expect(isCalendar(w)).toBe(want);
      if (want) dates++;
    }
    expect(dates).toBeGreaterThan(1_000);
  });

  test("sketchTerms: the eval's texts, fuzzed sentences and random code units", () => {
    const r = rng(18862);
    const texts = scenarioTexts();
    for (let i = 0; i < 20_000; i++) texts.push(r() < 0.6 ? sentence(r) : units(r));
    for (const t of texts) expect(sketchTerms(t)).toEqual(sketchTermsSplit(t));
  });

  test("sketchTerms on long texts (its table grows) and on many distinct words (every probe)", () => {
    const r = rng(18871);
    for (let i = 0; i < 60; i++) {
      const base = Array.from({ length: 40 }, () => sentence(r)).join(" ");
      const long = base.repeat(1 + Math.floor(r() * 200));
      expect(sketchTerms(long)).toEqual(sketchTermsSplit(long));
    }
    const letters = (k: number) => [...String(k)].map((d) => String.fromCharCode(97 + Number(d))).join("");
    const distinct = Array.from({ length: 7_000 }, (_, k) => `w${letters(k)}q`).join(" ");
    expect(sketchTerms(distinct)).toEqual(sketchTermsSplit(distinct));
    expect(distinct.length).toBeLessThan(TABLE_MAX_CHARS);
    expect(sketchTerms(distinct).length).toBe(7_000);
  });

  test("a 16M-character text leaves the module's table at or under its cap, and no call leaves a hash behind", () => {
    const r = rng(18873);
    const huge = Array.from({ length: 400 }, () => sentence(r))
      .join(" ")
      .repeat(64)
      .padEnd(16_000_000, " filler words");
    expect(huge.length).toBeGreaterThanOrEqual(16_000_000);
    expect(sketchTerms(huge)).toEqual(sketchTermsSplit(huge));
    expect(sketchTableSlots()).toBeLessThanOrEqual(TABLE_MAX_CHARS);
    const atCap = sentence(r).repeat(TABLE_MAX_CHARS).slice(0, TABLE_MAX_CHARS);
    expect(sketchTerms(atCap)).toEqual(sketchTermsSplit(atCap));
    expect(sketchTableSlots()).toBeLessThanOrEqual(TABLE_MAX_CHARS);
    expect(sketchTableClear()).toBe(true);
    // A text with a surrogate leaves the split to read it, and its hashes cleared too.
    sketchTerms(`${sentence(r)} 🎉 ${sentence(r)}`);
    expect(sketchTableClear()).toBe(true);
  });

  test("stopwordAt is isStopword on a word in place", () => {
    const r = rng(18872);
    const words = ["the", "THE", "them", "theme", "while", "whiles", "okay", "ok", "a", "", "über", "would", "you"];
    for (let i = 0; i < 5_000; i++) words.push(...sentence(r).toLowerCase().split(/\s+/));
    for (const w of words) expect(stopwordAt(`xx ${w} yy`, 3, 3 + w.length)).toBe(isStopword(w));
  });

  test("every stopword's hash is marked (D1911: a clear mark skips stopwordAt)", () => {
    const r = rng(1911);
    // The stopword list as text.ts holds it (copied: a stopword added there and not here is checked by the fuzz only).
    const words = (
      "a an and are as at be been but by can could did do does for from had has have he her him his how i if in into " +
      "is it its just me my no not of on or our please she so some than that the their them then there these they " +
      "this to up us was we were what when where which who why will with would you your yes ok okay thanks thank hi " +
      "hello hey sure great cool also about after again all am any because before being both each few get got here " +
      "more most much need only other out over own same should still such too under until very want way well while"
    ).split(" ");
    for (const w of words) expect(isStopword(w)).toBe(true);
    for (let i = 0; i < 2_000; i++) words.push(...sentence(r).toLowerCase().split(/\s+/));
    for (const w of words) if (isStopword(w)) expect(STOP_FNV[fnvOfWord(w) & 4_095]).toBe(1);
  });

  test("extractTypedEntities: the eval's texts, fuzzed sentences and random code units", () => {
    const r = rng(18863);
    const texts = scenarioTexts();
    for (let i = 0; i < 20_000; i++) texts.push(r() < 0.7 ? sentence(r) : units(r));
    let found = 0;
    for (const t of texts) {
      const want = entitiesBefore(t);
      expect(extractTypedEntities(t)).toEqual(want);
      found += want.length;
    }
    expect(found).toBeGreaterThan(20_000);
  });
});
