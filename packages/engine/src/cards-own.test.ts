import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ContextItem } from "@eden/protocol";
import { sentenceKey, sentenceKeyBefore, strictOwnText, worthCardingStrict, worthCardingStrictBefore } from "./cards";
import { packItem } from "./packed-text";

/*
 * D1915: the card queue's strict prefilter and sentence key read the item's own text once (`strictOwnText`, passed to
 * both by `enqueue`), where each made it from a spread copy of the item. `worthCardingStrictBefore` and
 * `sentenceKeyBefore` are the functions before; every answer here must be theirs, given the text read once or not, on
 * the eval's items, fuzzed mail (footers, greetings, replies, relative days, constraint words, long texts past the
 * 2,700-character read) and packed copies.
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

const PIECES = [
  "Hi Robin,",
  "Morning all -",
  "The deploy freeze holds until Friday.",
  "Do not share the deck outside the team.",
  "Payment is due by 30 Nov.",
  "Sam is on leave next week.",
  "Thanks, see you tomorrow.",
  "Lunch was great.",
  "This email and any attachments are confidential and may be privileged.\nPlease delete it.",
  "\n\nPS: the budget is capped at £5,000.",
  "From: Dana Lee <dana@example.com>\nTo: Robin",
  "On Mon, 2 Nov 2026, Sam wrote:\n> old text",
  "Manage your notifications here.",
  "You are receiving this because you subscribed.",
  "   ",
  "\n",
  "Approval needed before any spend over $500!",
  "The vendor is vegan-friendly; Kim is allergic to nuts.",
];
const TITLES = ["Atlas pricing", "Re: Atlas pricing", "Fwd: RE: atlas  pricing", "Lunch tomorrow", "", "Q3 plan"];

function mail(r: () => number, i: number): ContextItem {
  let text = "";
  const n = 1 + Math.floor(r() * 12);
  for (let k = 0; k < n; k++) text += PIECES[Math.floor(r() * PIECES.length)]! + (r() < 0.5 ? " " : "\n");
  if (r() < 0.1) text = text.repeat(40);
  return { id: `m${i}`, sourceId: "mail", ref: `m${i}`, title: TITLES[Math.floor(r() * TITLES.length)]!, text };
}

describe("the strict prefilter and sentence key read once (D1915) against their readings before", () => {
  test("the eval's items, fuzzed mail and packed copies", () => {
    const r = rng(1915);
    const items = [...scenarioItems(), ...Array.from({ length: 4_000 }, (_, i) => mail(r, i))];
    for (const plain of items) {
      for (const item of [plain, packItem(plain)]) {
        const own = strictOwnText(item);
        expect(worthCardingStrict(item, own)).toBe(worthCardingStrictBefore(item));
        expect(worthCardingStrict(item)).toBe(worthCardingStrictBefore(item));
        expect(sentenceKey(item, own)).toBe(sentenceKeyBefore(item));
        expect(sentenceKey(item)).toBe(sentenceKeyBefore(item));
      }
    }
  });
});
