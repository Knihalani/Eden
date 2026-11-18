import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import { foldEchoes } from "./fold";
import { namesParticipant, startDay } from "./grounding";
import { isPacked, packItem } from "./packed-text";
import { itemReadings, shownReadings } from "./partner";
import { mentions, mentionsAny, mentionText, mentionWords, settled } from "./probes";
import { type Anchors, anchorsOf, namesEntity, namesRequestDay } from "./settle";
import { extractTypedEntities, PERSISTABLE_KINDS } from "./text";

/*
 * D1920, the third low-level round (docs/research/opt-round3.md): each rewrite against the code it replaced, on fuzzed
 * items (surrogates, combining marks, regex metacharacters, odd spacing; packed and plain; plain ones edited in
 * place between reads, so every memo is checked against a fresh reading).
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

const NAMES = [
  "Jamie",
  "Jamie Fox",
  "Zoë Ruiz",
  "Zoé Ruiz",
  "İlker",
  "Łukasz",
  "C++ (team)",
  "a.b*c",
  "[x]",
  "$5 fund",
  "back\\slash",
  "Dana  Lee",
  "Dana\tLee",
  "Dana Lee",
  " back\\ slash ",
  "dana@lee.example",
  "J",
  "A B",
  "😀 Emoji",
  "\ud835\udc00lpha",
  "Ana-María",
  "O'Brien",
  "Robin Hale",
];

const PIECES = [
  "Lunch moved to 3pm",
  "as usual",
  "nothing has changed",
  "The issue is not resolved yet",
  "Is this resolved?",
  "Ticket resolved, closing.",
  "You can go ahead with the order.",
  "Monday 2 Nov, 18:00",
  "Fri at 19:00",
  "Mon 2 Nov ⋅ 18:00",
  "Wed 4 Nov 2026 - 09:30",
  "18:00–19:30",
  "perfect, booked",
  "cancelled instead",
  "with Dana",
  "dana \n\t lee",
  "dana lee",
  "back\\ \n slash",
  "from St. John",
  "😀 party",
  "\ud835\udc00lpha \ud840\udc00",
  "été",
  "Harlow-based",
  "Harlowe",
  " nbsp ",
  "x@y.example",
  "...",
  "  ",
  "\n",
  "\t",
  "#tag",
  "\ud800 lone",
];

function textOf(r: () => number, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    const roll = r();
    out += roll < 0.15 ? pick(r, NAMES) : pick(r, PIECES);
    out += pick(r, [" ", ". ", ", ", "\n", "  ", " - "]);
  }
  return out;
}

function itemOf(r: () => number, i: number): ContextItem {
  const it: ContextItem = {
    id: `m:${i}`,
    sourceId: pick(r, ["mail", "calendar", "chat"]),
    ref: String(i),
    title: textOf(r, 1 + Math.floor(r() * 3)),
    text: textOf(r, 1 + Math.floor(r() * 40)),
  };
  if (r() < 0.4) it.meta = { people: `${pick(r, NAMES)} <${pick(r, ["dana@lee.example", "jamie@fox.example"])}>` };
  // A dated item (an event): a calendar title then names its other party (`namesParticipant`).
  if (r() < 0.3) it.meta = { ...it.meta, start: `2026-11-0${2 + Math.floor(r() * 7)}T18:00:00Z` };
  // Long enough texts are held deflated, as the cache holds them.
  return r() < 0.5 ? packItem(it) : it;
}

/** Edits a plain item in place (a packed one's text is a fixed getter), as a sync's copy might be. */
function edit(r: () => number, it: ContextItem): void {
  if (!isPacked(it) && r() < 0.1) it.text = textOf(r, 1 + Math.floor(r() * 40));
  if (r() < 0.05) it.title = textOf(r, 1);
}

/** `namesEntity` as it was before D1920: a pattern compiled per entity per item. */
function namesEntityBefore(item: ContextItem, a: Anchors): boolean {
  if (a.entities.length === 0) return false;
  const text = `${item.title} ${item.text}`.toLowerCase().replace(/\s+/g, " ");
  return a.entities.some((e) => {
    if (namesParticipant(e, item)) return true;
    const w = e.toLowerCase().replace(/\s+/g, " ").trim();
    if (w.length < 2) return false;
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(text);
  });
}

const OLD_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function namesRequestDayBefore(item: ContextItem, a: Anchors): boolean {
  if (a.days.size === 0 && a.named.length === 0) return false;
  const start = startDay(item, a.offset);
  if (start !== null && a.days.has(start)) return true;

  const days = [...a.named];
  for (const d of a.days) {
    const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(d);
    if (m) days.push({ day: Number(m[2]), month: Number(m[1]) - 1 });
  }
  if (days.length === 0) return false;
  const text = `${item.title}\n${item.text}`.toLowerCase();
  for (const { day, month } of days) {
    const name = String.raw`${OLD_MONTHS[month]!}[a-z]*`;
    const dd = String(day).padStart(2, "0");
    const mm = String(month + 1).padStart(2, "0");
    const ordinal =
      day % 10 === 1 && day !== 11
        ? "st"
        : day % 10 === 2 && day !== 12
          ? "nd"
          : day % 10 === 3 && day !== 13
            ? "rd"
            : "th";
    const pattern = new RegExp(
      String.raw`\b${day}(?:st|nd|rd|th)?(?:\s+of)?\s+${name}\b|\b${name}\s+${day}(?:st|nd|rd|th)?\b|\b${day}${ordinal}\b|\b0?${day}/${mm}\b|\b${dd}\.${mm}\b`,
    );
    if (pattern.test(text)) return true;
  }
  return false;
}

describe("D1967: namesRequestDay's per-request day tester", () => {
  test("namesRequestDay matches its per-item pattern for seeded requests and items", () => {
    const r = rng(19661);
    const rawRequests = ["31st of October", "Oct 3", "the 12th", "30/10", "none"];
    const windows = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
    const anchors: Anchors[] = [];
    for (let count = 0; count <= 14; count++) {
      const shuffled = [...windows];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      for (const raw of rawRequests) {
        anchors.push(anchorsOf([], new Set(shuffled.slice(0, count)), raw, 0));
      }
    }

    const forms = [
      ["Meeting 31st of October", "No other date"],
      ["OCT 3", "Held at noon"],
      ["the 12th", ""],
      ["Invoice", "due 30/10"],
      ["", "31/11"],
      ["", "130th"],
      ["", "3RD OF OCTOBER"],
      ["October 31ST", "A follow-up"],
      ["", "30.10"],
      ["", "31 Oct"],
      ["Meeting on the 12TH", ""],
      ["", "No date here"],
    ];
    const items: ContextItem[] = [];
    let nextId = 0;
    for (const [title, body] of forms) {
      const plain: ContextItem = {
        id: `day:${nextId++}`,
        sourceId: "calendar",
        ref: String(nextId),
        title: title!,
        text: body!,
      };
      items.push(plain);
      const repeated = `${body || title} · `;
      const packed = packItem({
        ...plain,
        id: `day:${nextId++}`,
        ref: String(nextId),
        text: repeated.repeat(40),
      });
      expect(isPacked(packed)).toBe(true);
      items.push(packed);
    }
    for (const a of anchors) {
      const day = a.days.values().next().value;
      if (day) {
        items.push({
          id: `day:${nextId++}`,
          sourceId: "calendar",
          ref: String(nextId),
          title: "Undated title",
          text: "Undated body",
          meta: { start: `${day}T09:00:00Z` },
        });
      }
    }
    items.push({
      id: `day:${nextId++}`,
      sourceId: "calendar",
      ref: String(nextId),
      title: "Undated title",
      text: "Undated body",
      meta: { start: "2027-01-01T09:00:00Z" },
    });

    let yes = 0;
    let no = 0;
    for (const a of anchors) {
      for (const item of items) {
        const want = namesRequestDayBefore(item, a);
        expect(namesRequestDay(item, a)).toBe(want);
        if (want) yes++;
        else no++;
      }
    }
    expect(yes).toBeGreaterThan(0);
    expect(no).toBeGreaterThan(0);
  });
});

describe("D1920: memos and code-unit passes read as the code they replaced", () => {
  test("settledOf, per item object, is settled afresh", () => {
    const r = rng(19201);
    const items = Array.from({ length: 300 }, (_, i) => itemOf(r, i));
    let yes = 0;
    for (let step = 0; step < 20_000; step++) {
      const it = pick(r, items);
      edit(r, it);
      const want = settled(it);
      expect(itemReadings.settledOf(it)).toBe(want);
      if (want) yes++;
    }
    expect(yes).toBeGreaterThan(1_000);
    expect(yes).toBeLessThan(19_000);
  });

  test("the memos are per object: two users' items with the same text, or cues with the same names, share nothing", () => {
    // CLAUDE.md's isolation rule: every memo added here is keyed by object identity, never by content.
    const text = "The review is still on, as planned, with Dana Lee.";
    const mine: ContextItem = { id: "u1:m:1", sourceId: "mail", ref: "1", title: "Review", text };
    const theirs: ContextItem = { id: "u2:m:1", sourceId: "mail", ref: "1", title: "Review", text };
    expect(itemReadings.settledOf(mine)).toBe(true);
    expect(itemReadings.settledOf(theirs)).toBe(true);
    theirs.text = "The review moved to Friday with Dana Lee.";
    expect(itemReadings.settledOf(theirs)).toBe(false);
    expect(itemReadings.settledOf(mine)).toBe(true);
    // Two requests naming the same people hold their own tests: one's anchors answer for their own entities only.
    const a = anchorsOf(["Dana Lee"], null, "", 0);
    const b = anchorsOf(["Jamie Fox"], null, "", 0);
    expect(namesEntity(mine, a)).toBe(true);
    expect(namesEntity(mine, b)).toBe(false);
    expect(namesEntity(mine, anchorsOf(["Dana Lee"], null, "", 0))).toBe(true);
  });

  test("mentionText is the regex replace, code unit for code unit", () => {
    const r = rng(19202);
    const re = /[^\p{L}\p{N}@.]+/gu;
    const units = [
      32, 32, 9, 10, 46, 64, 97, 122, 65, 48, 233, 0x301, 0x130, 0xa0, 0x2014, 0x4e2d, 0xd83d, 0xde00, 0xdc00,
    ];
    // Pairs past the BMP: a letter (U+1D400, U+20000) the regex keeps whole, an emoji it replaces.
    const pairs = ["\ud835\udc00", "\ud840\udc00", "\ud83d\ude00"];
    for (let k = 0; k < 20_000; k++) {
      let s = "";
      const n = Math.floor(r() * 30);
      for (let i = 0; i < n; i++) {
        const roll = r();
        s +=
          roll < 0.05 ? pick(r, pairs) : String.fromCharCode(roll < 0.8 ? pick(r, units) : Math.floor(r() * 0x10000));
      }
      const lower = s.toLowerCase();
      expect(mentionText(lower)).toBe(lower.replace(re, " "));
    }
    for (const t of PIECES) expect(mentionText(t.toLowerCase())).toBe(t.toLowerCase().replace(re, " "));
  });

  test("mentionsAny is names.some(mentions)", () => {
    const r = rng(19203);
    const items = Array.from({ length: 300 }, (_, i) => itemOf(r, i));
    let yes = 0;
    for (let step = 0; step < 20_000; step++) {
      const it = pick(r, items);
      edit(r, it);
      const names = Array.from({ length: Math.floor(r() * 4) }, () => pick(r, NAMES));
      const want = names.some((n) => mentions(n, it));
      expect(mentionsAny(mentionWords(names), it)).toBe(want);
      if (want) yes++;
    }
    expect(yes).toBeGreaterThan(1_000);
  });

  test("namesEntity, its tests built once per anchors, is the per-item pattern", () => {
    const r = rng(19204);
    const items = Array.from({ length: 300 }, (_, i) => itemOf(r, i));
    let yes = 0;
    for (let request = 0; request < 1_000; request++) {
      const entities = Array.from({ length: Math.floor(r() * 4) }, () => pick(r, NAMES));
      const a = anchorsOf(entities, null, textOf(r, 3), 0);
      // One request's anchors against many items, as the push and the ask read them.
      for (let k = 0; k < 20; k++) {
        const it = pick(r, items);
        edit(r, it);
        const want = namesEntityBefore(it, a);
        expect(namesEntity(it, a)).toBe(want);
        if (want) yes++;
      }
    }
    expect(yes).toBeGreaterThan(1_000);
  });

  test("foldEchoes over held items (anchors memoised) is foldEchoes over fresh copies", () => {
    const r = rng(19205);
    const items = Array.from({ length: 200 }, (_, i) => itemOf(r, i));
    const focus = new Set(["lunch", "party"]);
    let folded = 0;
    for (let packet = 0; packet < 3_000; packet++) {
      const xs = Array.from({ length: 2 + Math.floor(r() * 5) }, () => ({ item: pick(r, items) }));
      for (const x of xs) edit(r, x.item);
      const o = { focus, year: pick(r, [2026, undefined]), self: pick(r, [null, "Robin Hale"]), rare: () => false };
      const held = foldEchoes(xs, o).map((x) => xs.indexOf(x));
      const fresh = xs.map((x) => ({ item: { ...x.item, text: x.item.text } }));
      const want = foldEchoes(fresh, o).map((x) => fresh.indexOf(x));
      expect(held).toEqual(want);
      if (want.length < xs.length) folded++;
    }
    expect(folded).toBeGreaterThan(100);
  });

  test("extractTypedEntities with a cap keeps the first persistable entities reading every run gave", () => {
    const r = rng(19207);
    const WORDS = ["Dana", "Lee", "Acme", "Corp", "Łukasz", "Émile", "Monday", "the", "and", "What", "We", "It"];
    const EXTRA = ["@dana_l", "ABC-123", "x@y.example", '"quoted words"', "https://a.example/x", ". ", "\n", ", "];
    const fresh = () =>
      `Q${pick(r, ["a", "e", "o"])}${pick(r, ["b", "d", "k", "m", "r", "t"])}${pick(r, ["an", "el", "or"])}`;
    let capped = 0;
    for (let k = 0; k < 4_000; k++) {
      let t = "";
      const n = Math.floor(r() * 120);
      for (let i = 0; i < n; i++) {
        const roll = r();
        // A fresh capitalised word now and then, so a long text holds more than 20 distinct names.
        const w = r() < 0.3 ? fresh() : pick(r, WORDS);
        t += roll < 0.1 ? pick(r, EXTRA) : roll < 0.5 ? w : w.toLowerCase();
        t += pick(r, [" ", " ", ". ", ", ", "\n"]);
      }
      const all = extractTypedEntities(t).filter((e) => PERSISTABLE_KINDS.has(e.kind));
      for (const cap of [0, 1, 5, 20]) {
        const got = extractTypedEntities(t, cap).filter((e) => PERSISTABLE_KINDS.has(e.kind));
        expect(got.slice(0, cap)).toEqual(all.slice(0, cap));
        if (cap === 20 && all.length > 20) capped++;
      }
    }
    expect(capped).toBeGreaterThan(100);
  });

  test("the shown-line readers are the split, slice and regex they replaced", () => {
    const r = rng(19206);
    const LINES = [
      "<context source=x>",
      "</context>",
      "- [mail] Lunch: moved to 3pm",
      "- [calendar] Standup 😀: 09:30",
      "- [chat] Zoé said İ ok",
      "- [mail]",
      "- [x] ] odd",
      "Eden: a note",
      "",
      "plain words",
      "- [mail] été C++ (team)",
    ];
    const words = /[\p{L}\p{N}]+/gu;
    let counted = 0;
    for (let k = 0; k < 20_000; k++) {
      const text = Array.from({ length: Math.floor(r() * 8) }, () => pick(r, LINES)).join("\n");
      const lines = shownReadings.itemLinesOf(text.split("\n"));
      const before = text
        .split("\n")
        .slice(1, -1)
        .filter((line) => line.startsWith("- ["));
      expect(shownReadings.noteLines(lines)).toEqual(before);
      const items = Array.from({ length: Math.floor(r() * 5) }, (_, i) => ({
        id: `i${i}`,
        sourceId: pick(r, ["mail", "calendar", "chat", "x"]),
        ref: "",
        title: "",
        text: "",
      }));
      const all = text.split("\n").filter((line) => line.startsWith("- ["));
      let n = 0;
      while (n < items.length && n < all.length && all[n]!.startsWith(`- [${items[n]!.sourceId}] `)) n++;
      expect(shownReadings.renderedCount(items, lines)).toBe(n);
      expect(shownReadings.renderedCount(items, text)).toBe(n);
      counted += n;
      for (const line of before) {
        const src = pick(r, ["mail", "Chat", "x😀"]);
        const said = line.slice(line.indexOf("] ") + 2);
        expect(shownReadings.lineWords(src, line)).toEqual(`${src} ${said}`.toLowerCase().match(words) ?? []);
      }
    }
    expect(counted).toBeGreaterThan(1_000);
  });
});
