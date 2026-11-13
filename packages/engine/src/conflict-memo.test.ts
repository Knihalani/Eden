import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import { ItemCache, sanitizeItem } from "./cache";
import { analyse } from "./conflict";

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
