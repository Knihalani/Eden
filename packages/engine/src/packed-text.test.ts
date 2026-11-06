import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import { ItemCache } from "./cache";
import { termIds } from "./text";
import { decodedCount, isPacked, MIN_PACK_CHARS, packItem } from "./packed-text";

const scope = { tenantId: "t", userId: "u" };
const NOW = Date.UTC(2026, 10, 6, 9);

function longText(tag: string): string {
  const line = `Re: the Lisbon offsite → budget “approved” — ${tag}; Zoë’s numbers ≈ 4,200 €, ok by Friday.\n`;
  return line.repeat(Math.ceil((MIN_PACK_CHARS * 3) / line.length));
}

function item(id: string, text: string, extra: Partial<ContextItem> = {}): ContextItem {
  return { id, sourceId: "mail", ref: `mail:${id}`, title: `Subject ${id}`, text, ...extra };
}

describe("packItem (packText, D188)", () => {
  test("a packed item reads, spreads, serialises and compares as the original", () => {
    const raw = item("a", longText("one"), { meta: { from: "Zoë" }, updatedAt: 5 });
    const packed = packItem(raw);
    expect(isPacked(packed)).toBe(true);
    expect(packed.text).toBe(raw.text);
    expect({ ...packed }).toEqual({ ...raw });
    expect(JSON.parse(JSON.stringify(packed))).toEqual(JSON.parse(JSON.stringify(raw)));
    expect(structuredClone(packed)).toEqual({ ...raw });
    expect(Object.keys(packed).sort()).toEqual(Object.keys(raw).sort());
    // A copy with new text is a plain item again.
    const cut = { ...packed, text: packed.text.slice(0, 10) };
    expect(cut.text).toBe(raw.text.slice(0, 10));
  });

  test("short text and text that does not shrink stay plain", () => {
    const short = item("s", "see you at 3pm");
    expect(packItem(short)).toBe(short);
    let noise = "";
    for (let i = 0; noise.length < MIN_PACK_CHARS * 4; i++) noise += String.fromCharCode(0x4e00 + ((i * 7919) % 20000));
    const random = item("r", noise);
    expect(packItem(random).text).toBe(noise);
  });

  test("every packed text decodes to its own item's text, past the decode memo's size", () => {
    const items = Array.from({ length: 600 }, (_, i) => packItem(item(`i${i}`, longText(`n${i}`))));
    for (let round = 0; round < 2; round++) {
      for (let i = items.length - 1; i >= 0; i--) expect(items[i]!.text).toBe(longText(`n${i}`));
    }
  });
});

describe("ItemCache with packText", () => {
  test("stores packed copies, returns the same text, and refreshes an unchanged copy without re-indexing", () => {
    const cache = new ItemCache();
    const raw = item("a", longText("one"));
    const [stored] = cache.put(scope, [raw], NOW);
    expect(isPacked(stored!)).toBe(true);
    expect(cache.get(scope, "a", NOW)!.text).toBe(raw.text);
    const rev = cache.revision(scope);
    expect(cache.put(scope, [item("a", longText("one"))], NOW + 1)).toEqual([]);
    expect(cache.revision(scope)).toBe(rev);
    // A refresh with the same words (a lookup's fresh copy, new details) keeps the text deflated (review finding).
    cache.put(scope, [item("a", longText("one"), { updatedAt: 9 })], NOW + 1);
    const refreshed = cache.get(scope, "a", NOW + 1)!;
    expect(isPacked(refreshed)).toBe(true);
    expect(refreshed.text).toBe(raw.text);
    expect(refreshed.updatedAt).toBe(9);
    const changed = cache.put(scope, [item("a", longText("two"))], NOW + 2);
    expect(changed.map((c) => c.text)).toEqual([longText("two")]);
  });

  test("text with a lone surrogate stays plain, so an unchanged refresh is not a change (review finding)", () => {
    const cache = new ItemCache();
    const cut = `${longText("emoji")}\uD83D`;
    const raw = item("e", cut);
    expect(packItem(raw)).toBe(raw);
    expect(cache.put(scope, [raw], NOW)[0]!.text).toBe(cut);
    const rev = cache.revision(scope);
    expect(cache.put(scope, [item("e", cut)], NOW + 1)).toEqual([]);
    expect(cache.revision(scope)).toBe(rev);
  });

  test("forgetting a user leaves the decode memo empty of their text", () => {
    const cache = new ItemCache();
    cache.put(scope, [item("a", longText("gone"))], NOW);
    expect(cache.get(scope, "a", NOW)!.text).toBe(longText("gone"));
    cache.forget(scope);
    expect(decodedCount()).toBe(0);
  });

  test("search ranks identically with and without packText", () => {
    const plain = new ItemCache({ packText: false });
    const compact = new ItemCache();
    expect(isPacked(new ItemCache({ packText: false }).put(scope, [item("p", longText("p"))], NOW)[0]!)).toBe(false);
    const items = Array.from({ length: 40 }, (_, i) =>
      item(`m${i}`, `${longText(`n${i}`)}${i % 3 === 0 ? " quarterly forecast" : ""}`),
    );
    plain.put(scope, items, NOW);
    compact.put(scope, items, NOW);
    const qa = termIds("quarterly forecast", plain.vocabOf(scope), false);
    const qb = termIds("quarterly forecast", compact.vocabOf(scope), false);
    const a = plain.search(scope, qa.ids.slice(), qa.n, 10, NOW);
    const b = compact.search(scope, qb.ids.slice(), qb.n, 10, NOW);
    expect(a.length).toBeGreaterThan(0);
    expect(b.map((h) => [h.item.id, h.score, h.item.text])).toEqual(a.map((h) => [h.item.id, h.score, h.item.text]));
  });

  test("one user's packed copy never answers another's read (isolation)", () => {
    const cache = new ItemCache();
    const other = { tenantId: "t", userId: "v" };
    cache.put(scope, [item("a", longText("mine"))], NOW);
    cache.put(other, [item("a", longText("theirs"))], NOW);
    for (let i = 0; i < 3; i++) {
      expect(cache.get(scope, "a", NOW)!.text).toBe(longText("mine"));
      expect(cache.get(other, "a", NOW)!.text).toBe(longText("theirs"));
    }
  });
});
