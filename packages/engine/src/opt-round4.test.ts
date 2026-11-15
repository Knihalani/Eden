import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ContextItem } from "@eden/protocol";
import {
  analyse,
  analyseUnfiltered,
  assess,
  assessEvery,
  datesByPlan,
  datesFor,
  frameOf,
  gateOf,
  type Verdict,
} from "./conflict";
import { timeWindow } from "./grounding";
import { tallies } from "./cache";
import { safeLine } from "./line";
import { clearDecoded, decodedCount, isPacked, packItem } from "./packed-text";
import { mentionsAny, mentionsAnyByText } from "./probes";
import * as fast from "./render";
import * as ref from "./render.reference";

/*
 * The fourth low-level round, on the ask path (docs/research/opt-round4-ask.md): each rewrite against the code it
 * replaced, which stays in the source or in render.reference.ts.
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

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

/** Every item (an object with a string title and text) in the eval's scenarios. */
function scenarioItems(): ContextItem[] {
  const dir = new URL("../../eval/scenarios/", import.meta.url).pathname;
  const out: ContextItem[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.title === "string" && typeof o.text === "string") {
        out.push({
          id: String(o.id ?? "x"),
          sourceId: String(o.sourceId ?? "s"),
          ref: "r",
          title: o.title,
          text: o.text,
          ...(typeof o.updatedAt === "number" ? { updatedAt: o.updatedAt } : {}),
        });
      }
      for (const x of Object.values(o)) walk(x);
    }
  };
  for (const f of new Bun.Glob("**/*.json").scanSync(dir)) walk(JSON.parse(readFileSync(`${dir}${f}`, "utf8")));
  return out;
}

describe("D1932: a statement's date patterns read once, its days worked out per request", () => {
  /** Date shapes and near misses for every pattern and date word `datesOf` reads. */
  const PIECES = [
    "from 6 nov",
    "from 6th of november",
    "since 3 oct",
    "starting 1 dec 2026",
    "effective 2 jan",
    "after 30 sep",
    "until 9th november 2026",
    "till 4 dec",
    "through 12 nov",
    "thru nov 14",
    "not before 20 oct",
    "to 6 nov",
    "by 3 nov",
    "before 1 dec",
    "no later than 5 nov",
    "expires 2 nov",
    "expired on 30 september",
    "expiring october 2027",
    "lapsed 1 aug",
    "ends 31 dec",
    "ended 2 feb",
    "due 14 nov",
    "deadline 9 nov",
    "valid until 4 apr",
    "on 7 nov",
    "on monday 9 nov",
    "the 12th of november",
    "friday 13 nov",
    "back on 9 nov",
    "back 12 dec",
    "6-9 nov",
    "6 - 9 november",
    "6 to 9 nov 2027",
    "friday 20 to monday 23 november",
    "26 oct to 6 nov",
    "20 dec - 5 jan",
    "30 oct - 2 nov 2026",
    "may 5",
    "march 2027",
    "on sept 30th, 2026",
    "valid to 2036",
    "expires 2031",
    "until 2029",
    "till the 10th",
    "back on the 3rd",
    "from the 21st",
    "until sunday",
    "back thursday",
    "by friday",
    "before wednesday, 4",
    "by 17:00",
    "by end",
    "due",
    "deadline",
    "8:00",
    "ref ops-412",
    "the market",
    "decide by 4",
    "31 feb",
    "29 feb 2028",
    "29 feb",
    "jan",
    "12",
    "the 3rd party vendor",
    "no later than monday",
    "and",
    ",",
  ];

  test("the plan replayed gives datesOf's answer: 12,000 fuzzed sentences, each at four instants, both vocabularies", () => {
    const r = rng(1932);
    let found = 0;
    for (let i = 0; i < 12_000; i++) {
      const n = 1 + Math.floor(r() * 6);
      const s = Array.from({ length: n }, () => pick(r, PIECES)).join(r() < 0.7 ? " " : "");
      const anchor = r() < 0.5 ? null : Date.UTC(2026, Math.floor(r() * 12), 1 + Math.floor(r() * 28));
      for (const vocab of [false, true]) {
        // One plan a statement, replayed at instants across the year, as a cached analysis is across requests.
        const nows = Array.from({ length: 4 }, () =>
          Date.UTC(2025 + Math.floor(r() * 3), Math.floor(r() * 12), 1 + Math.floor(r() * 28), r() * 24),
        );
        const got = datesByPlan(s, nows, vocab, anchor);
        for (const [k, now] of nows.entries()) {
          const want = datesFor(s, now, vocab, anchor, true);
          expect(got[k]).toEqual(want);
          if (want.spans.length + want.limits.length > 0) found++;
        }
      }
    }
    expect(found).toBeGreaterThan(30_000);
    expect(found).toBeLessThan(96_000);
  });

  test("the eval's sentences read the same", () => {
    const r = rng(19321);
    for (const it of scenarioItems()) {
      for (const s of `${it.title}. ${it.text}`.toLowerCase().split(/[.!?;\n]+\s|\n+/)) {
        for (const vocab of [false, true]) {
          const now = Date.UTC(2026, Math.floor(r() * 12), 1 + Math.floor(r() * 28));
          const anchor = now - 86_400_000;
          expect(datesByPlan(s, [now], vocab, anchor)[0]).toEqual(datesFor(s, now, vocab, anchor, true));
        }
      }
    }
  });
});

describe("D1930: the conflict analysis's entry never reads a packed item's text to check it", () => {
  // The eval's texts are short: several joined make texts long enough to pack (`MIN_PACK_CHARS`).
  const all = scenarioItems().map((x) => x.text);
  const r0 = rng(1930);
  const texts = Array.from({ length: 300 }, () =>
    Array.from({ length: 3 + Math.floor(r0() * 5) }, () => pick(r0, all)).join(r0() < 0.5 ? "\n" : " "),
  ).filter((t) => t.length >= 300);

  test("a packed item's analyses and gate equal a plain copy's, and a second read decodes nothing", () => {
    expect(texts.length).toBeGreaterThan(20);
    let packed = 0;
    for (const [k, text] of texts.entries()) {
      const plain: ContextItem = { id: `m${k}`, sourceId: "mail", ref: `${k}`, title: `Note ${k}`, text };
      const held = packItem({ ...plain });
      if (!isPacked(held)) continue;
      packed++;
      for (const vocab of [false, true]) {
        expect(analyse(held, vocab)).toEqual(analyseUnfiltered(plain, vocab));
        expect(gateOf(held, vocab)).toBe(gateOf({ ...plain }, vocab));
      }
      clearDecoded();
      // The entry is found without reading the text: nothing is decompressed.
      analyse(held, true);
      gateOf(held, true);
      expect(decodedCount()).toBe(0);
    }
    expect(packed).toBeGreaterThan(10);
  });

  test("a plain item edited in place is read again; a packed item's title or date change is too", () => {
    const it: ContextItem = { id: "a", sourceId: "mail", ref: "a", title: "Note", text: "Lunch is at noon." };
    expect(gateOf(it, false)).toBe(false);
    it.text = "The account is on hold until Friday.";
    expect(gateOf(it, false)).toBe(true);
    const long = `The account is on hold until Friday. ${"Nothing else to add here, thanks. ".repeat(20)}`;
    const held = packItem({ id: "b", sourceId: "mail", ref: "b", title: "Note", text: long });
    expect(isPacked(held)).toBe(true);
    const first = analyse(held, true);
    expect(analyse(held, true)).toBe(first);
    held.title = "Other";
    expect(analyse(held, true)).not.toBe(first);
    const second = analyse(held, true);
    held.updatedAt = 5;
    expect(analyse(held, true)).not.toBe(second);
  });
});

describe("D1931: a packet compacts only the items its size loop reaches", () => {
  const items = scenarioItems();
  const FOCI = [new Set(["freeze", "supplier", "nov"]), new Set(["budget", "q3", "hire"]), new Set<string>()];

  test("the lab's parts dump is told every item, in order, as when all were compacted first", () => {
    const r = rng(1931);
    for (let i = 0; i < 1_500; i++) {
      const pack = Array.from({ length: 1 + Math.floor(r() * 6) }, () => pick(r, items));
      const shownWords = new Set(["freeze", "budget", "robin", "the"]);
      const got: unknown[] = [];
      const want: unknown[] = [];
      const options = {
        maxBytes: 200 + Math.floor(r() * 2_000),
        focus: pick(r, FOCI),
        itemBytes: 60 + Math.floor(r() * 400),
        ...(r() < 0.5 ? { year: 2026 } : {}),
        dense: r() < 0.5,
        split: r() < 0.5,
        ...(r() < 0.4 ? { shownBefore: (x: ContextItem) => (x.id.endsWith("1") ? shownWords : undefined) } : {}),
      };
      const a = fast.renderPacket(pack, { ...options, onParts: (it, parts, text) => got.push([it.id, parts, text]) });
      const b = ref.renderPacket(pack, { ...options, onParts: (it, parts, text) => want.push([it.id, parts, text]) });
      expect(a).toBe(b);
      expect(got).toEqual(want);
    }
  });

  test("the reader's note is given each item as said, and only items the loop reaches", () => {
    const r = rng(19310);
    for (let i = 0; i < 1_500; i++) {
      const pack = Array.from({ length: 1 + Math.floor(r() * 6) }, () => pick(r, items));
      const got: string[] = [];
      const want: string[] = [];
      const focus = r() < 0.7 ? { focus: pick(r, FOCI) } : {};
      const before = r() < 0.5 ? { shownBefore: () => new Set(["the", "freeze"]) } : {};
      const options = { maxBytes: 200 + Math.floor(r() * 2_000), itemBytes: 120, ...focus, ...before };
      const a = fast.renderPacket(pack, { ...options, note: (x) => (got.push(`${x.id}|${x.text}`), "blocks: x") });
      const b = ref.renderPacket(pack, { ...options, note: (x) => (want.push(`${x.id}|${x.text}`), "blocks: x") });
      expect(a).toBe(b);
      expect(got).toEqual(want);
    }
  });
});

describe("D1933: compaction's native spacing test and its words' bytes", () => {
  /** `spacedOut` before D1933, the oracle. */
  function spacedOutLoop(s: string): boolean {
    let space = false;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 32) {
        if (space) return true;
        space = true;
      } else if (c === 9 || c === 13 || c === 12 || c === 11) return true;
      else space = false;
    }
    return false;
  }

  test("spacedOut answers as the loop did on 50,000 fuzzed strings", () => {
    const r = rng(19330);
    const UNITS = ["a", " ", " ", "\t", "\r", "\f", "\v", "\n", " ", " ", "é", "😀", "x y"];
    let yes = 0;
    for (let i = 0; i < 50_000; i++) {
      const s = Array.from({ length: Math.floor(r() * 12) }, () => pick(r, UNITS)).join("");
      expect(fast.spacedOut(s)).toBe(spacedOutLoop(s));
      if (spacedOutLoop(s)) yes++;
    }
    expect(yes).toBeGreaterThan(10_000);
    expect(yes).toBeLessThan(45_000);
  });

  test("safeLine gives the three replaces' line on 50,000 fuzzed strings", () => {
    // safeLine before D1933, verbatim.
    const CONTROLS = /[\u0000-\u0008\u000E-\u001F\u007F-\u0084\u0086-\u009F؜‎‏‪-‮⁦-⁩\u{E0000}-\u{E007F}]/gu;
    const before = (text: string) =>
      text
        .replace(CONTROLS, "")
        .replace(/[\s\u0085]+/g, " ")
        .replace(/[<＜﹤]/g, "&lt;")
        .trim();
    const r = rng(19332);
    const UNITS = ["a", " ", " ", "\t", "\r\n", "\v", "\u0085", " ", " ", "﻿", "\u0000", "‮", "<"];
    const MORE = ["\u{E0041}", "　", " ", "é", "😀", "\ud800", "\u001b[0m", "x"];
    for (let i = 0; i < 50_000; i++) {
      const s = Array.from({ length: Math.floor(r() * 12) }, () => (r() < 0.8 ? pick(r, UNITS) : pick(r, MORE))).join(
        "",
      );
      expect(safeLine(s)).toBe(before(s));
    }
  });

  test("compactText gives the reference's text with lone surrogates, astral letters and many parts", () => {
    const r = rng(19331);
    const PIECES = [
      "The freeze holds until 6 Nov.",
      "Budget 😀 capped.",
      "\ud800 lone.",
      "Q3 hire €4k.",
      "ok",
      "日本語の文。",
    ];
    const FOCI = [new Set(["freeze", "nov"]), new Set(["budget", "hire", "q3"]), new Set<string>()];
    for (let i = 0; i < 5_000; i++) {
      const text = Array.from({ length: 1 + Math.floor(r() * 12) }, () => pick(r, PIECES)).join(" ");
      const focus = pick(r, FOCI);
      const bytes = 20 + Math.floor(r() * 200);
      expect(fast.compactText(text, focus, bytes)).toBe(ref.compactText(text, focus, bytes));
    }
  });
});

describe("D1935: assess reads only the statements that can move its verdict", () => {
  /** Request pieces: names, days, amounts, a routine, references, actions, and words items hold. */
  const ASKS = [
    "Book lunch with Dana Lee",
    "Send Priya Raman the deck",
    "Schedule the release",
    "Deploy to production",
    "on Friday 6 November",
    "next week",
    "tomorrow",
    "from 2 to 9 November",
    "for £500",
    "with a 15% discount",
    "for 12 people at £40 a head",
    "same as usual",
    "INV-5842",
    "the Q3 budget",
    "renew the passport",
    "pay the invoice",
    "the supplier freeze",
    "hire a contractor",
  ];

  test("its verdict equals reading every statement, for 120,000 request and item pairs", () => {
    const r = rng(1935);
    const base = scenarioItems();
    // Long items: several of the eval's texts joined, so most statements carry no mark.
    const items = Array.from({ length: 400 }, (_, k) => {
      const parts = Array.from({ length: 1 + Math.floor(r() * 8) }, () => pick(r, base));
      return {
        id: `x${k}`,
        sourceId: "mail",
        ref: `${k}`,
        title: parts[0]!.title,
        text: parts.map((x) => x.text).join(r() < 0.5 ? " " : "\n"),
        ...(r() < 0.5 ? { updatedAt: Date.UTC(2026, 9, 1 + Math.floor(r() * 30)) } : {}),
      } as ContextItem;
    });
    const counts: Record<Verdict, number> = { conflict: 0, clear: 0, none: 0 };
    for (let i = 0; i < 3_000; i++) {
      const raw = Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(r, ASKS)).join(" ");
      const now = Date.UTC(2026, 9 + Math.floor(r() * 3), 1 + Math.floor(r() * 28), 9);
      const names = (raw.match(/[A-Z][a-z]+ [A-Z][a-z]+/g) ?? []).slice(0, 2);
      const frame = frameOf(raw, timeWindow(raw, now)?.days ?? null, now, names, r() < 0.7);
      const ties = r() < 0.2 ? new Set(["freeze", "production"]) : undefined;
      for (let k = 0; k < 40; k++) {
        const it = pick(r, items);
        const want = assessEvery(frame, it, now, ties);
        expect(assess(frame, it, now, ties)).toBe(want);
        counts[want]++;
      }
    }
    // Every verdict is exercised.
    expect(counts.conflict).toBeGreaterThan(400);
    expect(counts.clear).toBeGreaterThan(400);
    expect(counts.none).toBeGreaterThan(10_000);
  });
});

describe("D1936: an equal re-put counts the held copy's people out and in from one reading", () => {
  const PEOPLE = ["Dana Lee", "Priya Raman", "Sam Ortiz", "Robin Carter", "Ana Silva"];
  const ADDRESSES = ["dana@acme.com", "priya@globex.com", "sam@acme.com", "robin@example.org"];
  const user = () => ({
    addresses: new Map<string, number>(),
    parties: new Map<string, number>(),
    partied: 0,
    self: "x" as string | undefined,
    personNames: [] as unknown,
  });
  const state = (u: ReturnType<typeof user>) =>
    JSON.stringify([[...u.addresses], [...u.parties], u.partied, u.self, u.personNames]);

  test("the same counts, the same Map order and the same invalidations as two tallies, over 3,000 steps", () => {
    const r = rng(1936);
    const a = user();
    const b = user();
    const items: ContextItem[] = [];
    for (let i = 0; i < 3_000; i++) {
      if (items.length < 5 || r() < 0.3) {
        const lines = Array.from({ length: Math.floor(r() * 4) }, () => {
          const head = pick(r, ["From", "To", "Cc", "Attendees", "Owner"]);
          return `${head}: ${pick(r, PEOPLE)} <${pick(r, ADDRESSES)}>, ${pick(r, PEOPLE)}`;
        });
        const it: ContextItem = {
          id: `i${i}`,
          sourceId: "mail",
          ref: `${i}`,
          title: "t",
          text: `${lines.join("\n")}\n\nBody ${i}`,
          ...(r() < 0.3 ? { meta: { people: `${pick(r, PEOPLE)}; ${pick(r, PEOPLE)}` } } : {}),
        };
        items.push(it);
        tallies.tally(a, it, 1);
        tallies.tally(b, it, 1);
        continue;
      }
      const it = pick(r, items);
      tallies.tally(a, it, -1);
      tallies.tally(a, it, 1);
      tallies.retally(b, it);
      expect(state(b)).toBe(state(a));
      if (r() < 0.1) a.self = b.self = "x";
    }
  });
});

describe("D1934: mentionsAny searches the item's text in place", () => {
  /** Units each side of every class `mentionText` reads: letters, digits, "@", ".", spacing, punctuation. */
  const UNITS = [
    "a",
    "b",
    "é",
    "İ",
    "ß",
    "1",
    "@",
    ".",
    " ",
    "  ",
    "\t",
    "\n",
    "-",
    "'",
    ",",
    "’",
    " ",
    "😀",
    "\ud800",
  ];
  const WORDS = [
    "jamie",
    "fox",
    "dana",
    "lee",
    "dana@acme.com",
    "acme.com",
    "o'brien",
    "zoë",
    "i̇lker",
    "ab",
    "a.b",
    "😀x",
  ];

  test("the same answer as the copied text on 40,000 fuzzed items and names", () => {
    const r = rng(1934);
    let yes = 0;
    for (let i = 0; i < 40_000; i++) {
      const piece = () => (r() < 0.5 ? pick(r, WORDS) : pick(r, UNITS));
      const text = Array.from({ length: Math.floor(r() * 14) }, piece).join(r() < 0.5 ? "" : " ");
      const title = Array.from({ length: Math.floor(r() * 4) }, piece).join(" ");
      const people = r() < 0.2 ? Array.from({ length: 2 }, piece).join(" ") : undefined;
      const item: ContextItem = {
        id: "i",
        sourceId: "s",
        ref: "r",
        title,
        text,
        ...(people !== undefined ? { meta: { people } } : {}),
      };
      const words = Array.from({ length: Math.floor(r() * 3) }, () =>
        Array.from({ length: 1 + Math.floor(r() * 2) }, () => (r() < 0.9 ? pick(r, WORDS) : pick(r, UNITS).trim())),
      );
      const lower = `${title} ${text} ${people ?? ""}`.toLowerCase();
      const want = mentionsAnyByText(words, lower);
      expect(mentionsAny(words, item)).toBe(want);
      if (want) yes++;
    }
    expect(yes).toBeGreaterThan(3_000);
    expect(yes).toBeLessThan(36_000);
  });
});
