import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ContextItem } from "@eden/protocol";
import { createHash } from "node:crypto";
import { DEONTIC, ownText, sentenceKey, strictOwnText, worthCardingStrict } from "./cards";
import { packItem } from "./packed-text";

/*
 * D1915: the card queue's strict prefilter and sentence key read the item's own text once (`strictOwnText`, passed to
 * both by `enqueue`), where each made it from a spread copy of the item. `worthCardingStrictBefore` and
 * `sentenceKeyBefore` below are the functions before, verbatim, with cards.ts's patterns they read copied beside them
 * (`DEONTIC` imported); every answer here must be theirs, given the text read once or not, on
 * the eval's items, fuzzed mail (footers, greetings, replies, relative days, constraint words, long texts past the
 * 2,700-character read) and packed copies.
 */

const READ_CHARS = 900;
const FOOTER =
  /(?:confidentiality notice|this (?:e-?mail|message) and any attachments?|if you (?:are not|have received this) (?:the )?(?:intended|in error)|notification (?:preferences|settings)|manage (?:your )?(?:notifications|email preferences|subscriptions?)|to (?:stop|change what you) receiv)(?:[^\n]|\n(?![ \t]*\n))*/gi;
const REPLY_TITLE = /^\s*(?:re|fwd?|aw|sv)\s*:/i;
const GREETING =
  /^(?:hi|hello|hey|hiya|dear|morning|good (?:morning|afternoon|evening)|all)\b[^,.!?:;\n]{0,40}[,!:–—-]\s*/;
const RELATIVE =
  /\b(?:today|tonight|tomorrow|yesterday|next|this (?:week|weekend|month|morning|afternoon|evening)|last|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|in \d+ (?:days?|weeks?|months?)|end of (?:the )?(?:day|week|month)|eod|eow|asap|soon|later)\b/i;

/** `worthCardingStrict` as it read before D1915 (its own text from a spread copy), for its differential test. */
function worthCardingStrictBefore(item: ContextItem): boolean {
  const own = ownText({ ...item, text: item.text.slice(0, READ_CHARS * 3).replace(FOOTER, "") });
  const title = REPLY_TITLE.test(item.title) ? "" : item.title.slice(0, 200);
  return DEONTIC.test(`${title}\n${own}`);
}

/** `sentenceKey` as it read before D1915, for its differential test. */
function sentenceKeyBefore(item: ContextItem): string | undefined {
  const own = ownText({ ...item, text: item.text.slice(0, READ_CHARS * 3).replace(FOOTER, "") }).toLowerCase();
  const held = own
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.replace(GREETING, "").trim())
    .filter((x) => x.length > 0 && DEONTIC.test(x));
  if (held.length === 0 || held.some((x) => RELATIVE.test(x))) return undefined;
  let title = item.title.slice(0, 200);
  while (REPLY_TITLE.test(title)) title = title.replace(REPLY_TITLE, "");
  if (RELATIVE.test(title)) return undefined;
  return createHash("sha256")
    .update([title.trim().replace(/\s+/g, " ").toLowerCase(), ...[...new Set(held)].sort()].join("\n"))
    .digest("hex")
    .slice(0, 32);
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
