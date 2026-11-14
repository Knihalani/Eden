import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ContextItem } from "@eden/protocol";
import { ItemCache, sanitizeItem } from "./cache";
import { analyse, analyseUnfiltered, anyMark, arrangedVisit, gateOf, MARK_LISTS, mayConstrain } from "./conflict";

/*
 * D1722: a lookup re-stores every item it finds, and `put` replaced the held object even when the copy was equal in
 * every field, so the conflict test's per-object `analyse` read each found item again on every request (73-78% of
 * analyses in pipeline.bench were of an item already read). An equal copy now keeps the held object.
 */

const NOW = Date.UTC(2026, 10, 2, 9);
const alice = { tenantId: "t", userId: "alice" };
const LONG = " The supplier freeze holds until 6 Nov; no new purchase orders before then.".repeat(6);

const item = (ref: string, text: string, extra: Partial<ContextItem> = {}): ContextItem => ({
  id: `mail:${ref}`,
  sourceId: "mail",
  ref,
  title: `Note ${ref}`,
  text,
  ...extra,
});

/** Mulberry32, so a failing sequence reproduces. */
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

/** Every own field of an item as plain data (a packed item's text getter read). */
const fields = (x: ContextItem) =>
  JSON.stringify(
    Object.keys(x)
      .sort()
      .map((k) => [k, (x as unknown as Record<string, unknown>)[k]]),
  );

describe("an equal copy keeps the held object (D1722)", () => {
  for (const packText of [true, false]) {
    test(`a re-put of an equal copy keeps the object, so its analysis is read once (packText ${packText})`, () => {
      const cache = new ItemCache({ packText });
      cache.put(alice, [item("a", LONG, { updatedAt: NOW - 1_000, meta: { from: "ops" } })], NOW);
      const held = cache.get(alice, "mail:a", NOW)!;
      const a = analyse(held, true);
      const rev = cache.revision(alice);
      cache.put(alice, [item("a", LONG, { updatedAt: NOW - 1_000, meta: { from: "ops" } })], NOW + 5);
      const again = cache.get(alice, "mail:a", NOW + 5)!;
      expect(again).toBe(held);
      expect(analyse(again, true)).toBe(a);
      expect(cache.revision(alice)).toBe(rev);
    });

    test(`a copy with other details is a new object with them, and is analysed anew (packText ${packText})`, () => {
      const cache = new ItemCache({ packText });
      cache.put(alice, [item("a", LONG, { updatedAt: NOW - 1_000 })], NOW);
      const held = cache.get(alice, "mail:a", NOW)!;
      const a = analyse(held, true);
      const rev = cache.revision(alice);
      for (const [k, extra] of [
        ["updatedAt", { updatedAt: NOW - 500 }],
        ["meta", { updatedAt: NOW - 500, meta: { from: "ops" } }],
        ["url", { updatedAt: NOW - 500, meta: { from: "ops" }, url: "https://x.test/a" }],
      ] as const) {
        const before = cache.get(alice, "mail:a", NOW)!;
        cache.put(alice, [item("a", LONG, extra)], NOW + 1);
        const now = cache.get(alice, "mail:a", NOW + 1)!;
        expect([k, now === before]).toEqual([k, false]);
        expect(fields(now)).toBe(fields(sanitizeItem(item("a", LONG, extra))));
      }
      expect(cache.revision(alice)).toBeGreaterThan(rev);
      const fresh = cache.get(alice, "mail:a", NOW + 1)!;
      expect(analyse(fresh, true)).not.toBe(a);
      expect(analyse(fresh, true).anchor).toBe(NOW - 500);
    });
  }

  test("fuzz: after every put the held copy is the last one put, and its analysis is the fresh copy's", () => {
    const r = rng(1722);
    const texts = [LONG, `${LONG} Approved.`, "short note, approved for 4 Nov", "no restrictions on the 5th"];
    for (const packText of [true, false]) {
      const cache = new ItemCache({ packText });
      const last = new Map<string, ContextItem>();
      for (let step = 0; step < 3_000; step++) {
        const ref = String(Math.floor(r() * 6));
        const prev = last.get(ref);
        const pick = r();
        // Mostly the previous copy again (what a lookup re-stores), else one field changed.
        const next: ContextItem =
          prev && pick < 0.6
            ? { ...prev }
            : item(ref, texts[Math.floor(r() * texts.length)]!, {
                ...(r() < 0.5 ? { updatedAt: NOW - Math.floor(r() * 3) * 60_000 } : {}),
                ...(r() < 0.3 ? { meta: { from: r() < 0.5 ? "ops" : "legal" } } : {}),
                ...(r() < 0.2 ? { url: `https://x.test/${Math.floor(r() * 2)}` } : {}),
                ...(r() < 0.1 ? { title: "Renamed" } : {}),
              });
        const before = cache.get(alice, next.id, NOW);
        if (before) analyse(before, step % 2 === 0); // a memo the next put must not leave stale
        cache.put(alice, [next], NOW);
        last.set(ref, next);
        const held = cache.get(alice, next.id, NOW)!;
        expect(fields(held)).toBe(fields(sanitizeItem(next)));
        if (before && fields(before) === fields(held)) expect(held).toBe(before);
        const clone = structuredClone(held);
        for (const v of [false, true]) expect(analyse(held, v)).toEqual(analyse(clone, v));
      }
    }
  });

  test("a field a connector added, or one key more or less, is a new object too (review finding)", () => {
    const cache = new ItemCache();
    const extra = (v: unknown) => ({ ...item("a", LONG, { updatedAt: NOW - 1 }), kind: v }) as ContextItem;
    cache.put(alice, [extra("mail")], NOW);
    const held = cache.get(alice, "mail:a", NOW)!;
    cache.put(alice, [extra("mail")], NOW);
    expect(cache.get(alice, "mail:a", NOW)).toBe(held);
    cache.put(alice, [extra("chat")], NOW);
    const changed = cache.get(alice, "mail:a", NOW)! as ContextItem & { kind?: string };
    expect(changed).not.toBe(held);
    expect(changed.kind).toBe("chat");
    cache.put(alice, [item("a", LONG, { updatedAt: NOW - 1 })], NOW);
    expect("kind" in cache.get(alice, "mail:a", NOW)!).toBe(false);
  });

  test("a key the held copy has only through its prototype is a new object (second review)", () => {
    const cache = new ItemCache();
    const base = item("a", LONG, { updatedAt: NOW - 1 });
    cache.put(alice, [{ ...base, z: 1 } as ContextItem], NOW);
    const held = cache.get(alice, "mail:a", NOW)!;
    // `in` sees Object.prototype's `constructor`; an own-key test does not.
    cache.put(alice, [{ ...base, constructor: Object } as unknown as ContextItem], NOW);
    expect(cache.get(alice, "mail:a", NOW)).not.toBe(held);
  });

  test("isolation: an equal copy keeps only the putting user's own object", () => {
    const cache = new ItemCache();
    const bob = { tenantId: "t", userId: "bob" };
    const other = { tenantId: "t2", userId: "alice" };
    for (const s of [alice, bob, other]) cache.put(s, [item("a", LONG, { updatedAt: NOW - 1 })], NOW);
    const held = [alice, bob, other].map((s) => cache.get(s, "mail:a", NOW)!);
    expect(new Set(held).size).toBe(3);
    cache.put(bob, [item("a", LONG, { updatedAt: NOW - 1 })], NOW + 1);
    expect(cache.get(bob, "mail:a", NOW + 1)).toBe(held[1]!);
    expect(cache.get(alice, "mail:a", NOW + 1)).toBe(held[0]!);
    expect(cache.get(other, "mail:a", NOW + 1)).toBe(held[2]!);
  });
});

/*
 * D1723: `analysis` tests each sentence against one union of every mark list (`anyMark`) and skips the lists' passes
 * on a sentence it does not match. Identical outputs need exactly: the union matches a sentence when, and only when,
 * one of the lists does. Checked on the eval's item texts and on fuzzed sentences built from the lists' own words.
 */

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
          sourceId: "s",
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

/** The literal words of the mark lists' sources, so fuzzed sentences hit them, their negations and their edges. */
const LIST_WORDS = [
  ...new Set(
    MARK_LISTS[1]
      .flatMap((re) => re.source.replace(/\\[bsdw]|\(\?<?[=!:]/g, " ").split(/[^a-z'-]+/))
      .filter((w) => w.length > 1),
  ),
];
const FILLER = (
  "the a we our booking freeze hold order team not no never don't until unless if when before is was has been " +
  "on off for to from by 6 nov 2026 friday sam lunch invoice approved released released. payment it's i'm"
).split(" ");

function fuzzSentence(r: () => number): string {
  const n = 1 + Math.floor(r() * 12);
  const words: string[] = [];
  for (let i = 0; i < n; i++) {
    const pool = r() < 0.45 ? LIST_WORDS : FILLER;
    let w = pool[Math.floor(r() * pool.length)]!;
    // Near misses: a word cut short, run on, capitalised or hyphenated.
    const k = r();
    if (k < 0.05) w = w.slice(0, Math.max(1, w.length - 1));
    else if (k < 0.1) w = `${w}x`;
    else if (k < 0.14) w = w.toUpperCase();
    else if (k < 0.17) w = `-${w}`;
    words.push(w);
  }
  return words.join(r() < 0.1 ? "  " : " ");
}

describe("the mark lists' union (D1723)", () => {
  const listsMatch = (s: string, vocab: boolean) =>
    MARK_LISTS[vocab ? 1 : 0].some((re) => new RegExp(re.source, re.flags.replace("g", "")).test(s));

  test("the union matches a sentence exactly when one of the lists does: eval sentences and 60,000 fuzzed", () => {
    const sentences = scenarioItems().flatMap((x) =>
      `${x.title}. ${x.text}`.toLowerCase().split(/[.!?;\n]+\s|\n+|,? but /),
    );
    expect(sentences.length).toBeGreaterThan(500);
    const r = rng(1723);
    for (let i = 0; i < 60_000; i++) sentences.push(fuzzSentence(r));
    let hits = 0;
    for (const s of sentences) {
      for (const vocab of [false, true]) {
        const want = listsMatch(s, vocab);
        if (anyMark(s, vocab) !== want) throw new Error(`union differs (vocab ${vocab}) on ${JSON.stringify(s)}`);
        if (want) hits++;
      }
    }
    // Both sides are exercised: many sentences hold a mark, many do not.
    expect(hits).toBeGreaterThan(20_000);
    expect(hits).toBeLessThan(sentences.length * 2 - 20_000);
  });

  test("analyses with the prefilter equal analyses without it: every eval item and fuzzed texts", () => {
    const items = scenarioItems();
    const r = rng(17230);
    for (let i = 0; i < 3_000; i++) {
      const text = Array.from({ length: 1 + Math.floor(r() * 6) }, () => fuzzSentence(r)).join(r() < 0.5 ? ". " : "\n");
      items.push({ id: `f${i}`, sourceId: "s", ref: "r", title: fuzzSentence(r), text, updatedAt: NOW - i * 60_000 });
    }
    expect(items.length).toBeGreaterThan(3_100);
    for (const it of items) {
      for (const vocab of [false, true]) {
        expect(analyse(structuredClone(it), vocab)).toEqual(analyseUnfiltered(it, vocab));
      }
    }
  });
});

describe("the reader gate's reading, once per item (D1880)", () => {
  /** The gate's test as `constraintLike` read it before D1880, on every call. */
  const before = (it: ContextItem, visits: boolean) => {
    const text = `${it.title}. ${it.text}`.toLowerCase();
    return mayConstrain(text) || (visits && arrangedVisit(text));
  };

  test("gateOf answers as the per-call test, read first with or without visits, and again from its memo", () => {
    const items = scenarioItems();
    const r = rng(1880);
    for (let i = 0; i < 3_000; i++) {
      const text = Array.from({ length: 1 + Math.floor(r() * 6) }, () => fuzzSentence(r)).join(r() < 0.5 ? ". " : "\n");
      items.push({ id: `f${i}`, sourceId: "s", ref: "r", title: fuzzSentence(r), text });
    }
    items.push(item("v", "I've booked the engineer, he'll come Thursday between 8 and 12."));
    let open = 0;
    for (const it of items) {
      const first = r() < 0.5;
      for (const visits of [first, !first, first, !first]) expect(gateOf(it, visits)).toBe(before(it, visits));
      if (before(it, true)) open++;
    }
    // Both answers are exercised.
    expect(open).toBeGreaterThan(500);
    expect(open).toBeLessThan(items.length - 500);
  });

  test("an item whose text or title changes in place is read again", () => {
    const it = item("m", "Lunch is at noon.");
    expect(gateOf(it, true)).toBe(false);
    it.text = "The account is on hold until Friday.";
    expect(gateOf(it, true)).toBe(true);
    it.text = "Lunch is at noon.";
    expect(gateOf(it, false)).toBe(false);
    it.title = "Visit: I've booked the plumber, he'll come Monday";
    expect(gateOf(it, false)).toBe(false);
    expect(gateOf(it, true)).toBe(true);
  });
});
