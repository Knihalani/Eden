import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ContextItem } from "@eden/protocol";
import * as fast from "./render";
import * as ref from "./render.reference";

/*
 * D1881: the packet's compaction runs its whole-text passes only where the text holds what they match, reads words by
 * a code-unit scan (`wordsIn`), and reads a part's words once for the known test and `pick`. `render.reference.ts` is
 * render.ts before it; every output here must be the reference's, on the eval's items and on fuzzed messages built
 * from the shapes each pass and precheck reads (quotes, sign-offs, URLs, tabs and runs of spaces, years, the user's
 * name, tables, attendees, characters past Latin-1 and past the BMP).
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

/** Every item (an object with a string title and text) in the eval's scenarios. */
function scenarioItems(): ContextItem[] {
  const dir = new URL("../../eval/scenarios/", import.meta.url).pathname;
  const out: ContextItem[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.title === "string" && typeof o.text === "string") {
        out.push({ id: String(o.id ?? "x"), sourceId: "s", ref: "r", title: o.title, text: o.text });
      }
      for (const x of Object.values(o)) walk(x);
    }
  };
  for (const f of new Bun.Glob("**/*.json").scanSync(dir)) walk(JSON.parse(readFileSync(`${dir}${f}`, "utf8")));
  return out;
}

const SELF = "Robin Carter";
const FRAGMENTS = [
  "Hi Sam,",
  "Hello Dana, ",
  "Morning Robin, Thanks for this.",
  "The supplier freeze holds until 6 Nov 2026.",
  "Can we move the call to Sat, 24 Oct 2026 12:00?",
  "Robin Carter will join; Robin Carter's deck is attached.",
  "On Mon, 2 Nov 2026 at 09:14 Dana Lee <dana@acme.com> wrote:",
  "> The budget is capped at £40,000 for Q3.",
  ">> No new hires until January.",
  " > quoted after a space",
  "Best regards,",
  "Best regards, Robin Carter",
  "— Dana",
  "--",
  "Sent from my iPhone",
  "See https://example.com/a?b=1 for details.",
  "Link:http://x.y/z",
  "Join with Google Meet: https://meet.google.com/abc",
  "You are receiving this because you were mentioned.",
  "From: Owen Price <owen@x.com>",
  "To: Robin Carter <robin@x.com>, Ana Ruiz",
  "Cc: legal@x.com",
  "Subject: Re: 2025/26 return",
  "Attendees: Robin Carter, Nadia Petrova, Ben Okafor <ben@x.com>",
  "| Ana | yes | | Ben | no |",
  "|---|---|",
  "Booked St. John for Tuesday. Dr. Okafor confirms.",
  "Lunch with Nadia Petrova Wednesday 4 Nov ⋅ 10:30 Padella",
  "Zoë and Tomás meet in Malmö; Łukasz joins from Kraków.",
  "会议改到星期五。",
  "Party 🎉 at 8pm, bring 🍕.",
  "Thanks so much!",
  "Let me know if that works.",
  "ok",
  "Invoice INV-5842 is overdue by 14 days.",
  "\t\tindented\twith tabs",
  "two  spaces   here",
  "line\r\nbreak",
  "\u000bvertical\fform",
  "price 20%; 3rd party vendor",
  "Sorry for the slow reply.",
];
const SEPARATORS = [" ", "  ", "\n", "\n\n", " \n ", "\t", ". ", "\r\n"];

function message(r: () => number): string {
  const n = 1 + Math.floor(r() * 9);
  let out = "";
  for (let i = 0; i < n; i++) {
    out += FRAGMENTS[Math.floor(r() * FRAGMENTS.length)]!;
    out += SEPARATORS[Math.floor(r() * SEPARATORS.length)]!;
  }
  return out;
}

/** A random string over the code units every word scan must classify: ASCII, Latin-1, the BMP, surrogates. */
function units(r: () => number): string {
  const n = Math.floor(r() * 40);
  let s = "";
  for (let i = 0; i < n; i++) {
    const x = r();
    const c =
      x < 0.5
        ? 32 + Math.floor(r() * 95)
        : x < 0.7
          ? 0x80 + Math.floor(r() * 0x180)
          : x < 0.9
            ? Math.floor(r() * 0xd800)
            : x < 0.95
              ? 0xd800 + Math.floor(r() * 0x800)
              : 0xe000 + Math.floor(r() * 0x2000);
    s += String.fromCharCode(c);
  }
  return s;
}

const FOCI = [new Set<string>(), new Set(["freeze", "budget", "nov", "dana"]), new Set(["robin", "invoice", "20"])];

function corpus(): ContextItem[] {
  const r = rng(1881);
  const out = scenarioItems();
  for (let i = 0; i < 1_200; i++) {
    out.push({ id: `f${i}`, sourceId: "mail", ref: String(i), title: message(r).slice(0, 80), text: message(r) });
  }
  return out;
}

describe("render's fast reading (D1881) against the reference", () => {
  const items = corpus();

  test("wordsIn is the regex's match on every kind of code unit", () => {
    const WORDS = /[\p{L}\p{N}]+/gu;
    const r = rng(7);
    for (let i = 0; i < 20_000; i++) {
      const s = units(r);
      expect(fast.wordsIn(s)).toEqual(s.match(WORDS) ?? []);
    }
    for (const it of items)
      expect(fast.wordsIn(it.text.toLowerCase())).toEqual(it.text.toLowerCase().match(WORDS) ?? []);
  });

  test("messageParts and compactText give the reference's output", () => {
    const r = rng(11);
    let compared = 0;
    for (const it of items) {
      const knownWords = new Set(
        it.text
          .toLowerCase()
          .match(/[a-z]+/g)
          ?.filter(() => r() < 0.4) ?? [],
      );
      const known = (w: string) => knownWords.has(w);
      for (const year of [undefined, 2026]) {
        for (const self of [undefined, null, SELF]) {
          for (const split of [false, true, undefined]) {
            const dense = r() < 0.5 ? { title: it.title } : undefined;
            expect(fast.messageParts(it.text, known, year, self, dense, split)).toEqual(
              ref.messageParts(it.text, known, year, self, dense, split),
            );
            const focus = FOCI[Math.floor(r() * FOCI.length)]!;
            const bytes = 40 + Math.floor(r() * 400);
            expect(fast.compactText(it.text, focus, bytes, known, year, self, dense, split)).toBe(
              ref.compactText(it.text, focus, bytes, known, year, self, dense, split),
            );
            compared++;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(15_000);
  });

  test("renderPacket gives the reference's packet", () => {
    const r = rng(13);
    for (let i = 0; i < 3_000; i++) {
      const pack = Array.from({ length: 1 + Math.floor(r() * 5) }, () => items[Math.floor(r() * items.length)]!);
      const shownWords = new Set(["freeze", "budget", "robin", "the"]);
      const options = {
        maxBytes: 200 + Math.floor(r() * 3_000),
        ...(r() < 0.8 ? { focus: FOCI[Math.floor(r() * FOCI.length)]! } : {}),
        itemBytes: 60 + Math.floor(r() * 400),
        ...(r() < 0.5 ? { year: 2026 } : {}),
        ...(r() < 0.5 ? { self: SELF } : {}),
        dense: r() < 0.5,
        split: r() < 0.5,
        ...(r() < 0.4 ? { shownBefore: (x: ContextItem) => (x.id.endsWith("1") ? shownWords : undefined) } : {}),
        ...(r() < 0.3 ? { note: (x: ContextItem) => (x.id.endsWith("2") ? "blocks: the freeze | x" : undefined) } : {}),
        ...(r() < 0.3 ? { lead: fast.CANDIDATES_LEAD } : {}),
      };
      expect(fast.renderPacket(pack, options)).toBe(ref.renderPacket(pack, options));
    }
  });

  test("the parts memo (D1882): reused across packets and settings, read again when an item changes in place", () => {
    const r = rng(1882);
    fast.clearParts();
    const pool = items.slice(0, 40).map((x) => ({ ...x }));
    for (let i = 0; i < 2_000; i++) {
      const it = pool[Math.floor(r() * pool.length)]!;
      // An item edited in place: its text or title changes under the same object.
      if (r() < 0.05) it.text = message(r);
      if (r() < 0.03) it.title = message(r).slice(0, 60);
      const pack = [it, pool[Math.floor(r() * pool.length)]!];
      const seen = new Set(message(r).toLowerCase().split(/\W+/));
      const options = {
        maxBytes: 2_000,
        focus: FOCI[Math.floor(r() * FOCI.length)]!,
        itemBytes: 80 + Math.floor(r() * 300),
        ...(r() < 0.5 ? { year: 2026 } : {}),
        ...(r() < 0.5 ? { self: SELF } : {}),
        dense: r() < 0.5,
        split: r() < 0.5,
        ...(r() < 0.5 ? { shownBefore: () => seen } : {}),
      };
      expect(fast.renderPacket(pack, options)).toBe(ref.renderPacket(pack, options));
    }
    expect(fast.partsMemoCount()).toBeGreaterThan(0);
    expect(fast.partsMemoCount()).toBeLessThanOrEqual(pool.length);
    fast.clearParts();
    expect(fast.partsMemoCount()).toBe(0);
  });

  test("the parts memo holds at most 256 items, oldest out first", () => {
    fast.clearParts();
    const many = items.slice(0, 300);
    for (const it of many) fast.renderPacket([it], { maxBytes: 1_000, focus: FOCI[1]! });
    expect(fast.partsMemoCount()).toBe(256);
    fast.clearParts();
  });

  test("the parts memo holds at most 1,200,000 characters of text, counted exactly", () => {
    fast.clearParts();
    const r = rng(18820);
    const big = Array.from({ length: 200 }, (_, i) => ({
      id: `b${i}`,
      sourceId: "mail",
      ref: String(i),
      title: `Big ${i}`,
      text: Array.from({ length: 200 }, () => message(r))
        .join(" ")
        .slice(0, 8_000),
    }));
    for (let i = 0; i < 1_000; i++) {
      const it = big[Math.floor(r() * big.length)]!;
      if (r() < 0.1) it.text = message(r).repeat(60).slice(0, 8_000);
      fast.renderPacket([it], { maxBytes: 1_000, focus: FOCI[1]!, ...(r() < 0.5 ? { year: 2026 } : {}) });
      expect(fast.partsMemoChars()).toBeLessThanOrEqual(1_200_000);
    }
    // The count is the held readings' texts, summed: what a clear gives back.
    expect(fast.partsMemoChars()).toBeGreaterThan(1_000_000);
    fast.clearParts();
    expect(fast.partsMemoChars()).toBe(0);
  });
});
