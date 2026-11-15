import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import { ItemCache } from "./cache";
import { termIds } from "./text";
import { clearDecoded, decodedCount, isPacked, MIN_PACK_CHARS, packedOf, packItem } from "./packed-text";
import { deflatePacked } from "./packed-text.reference";

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

  test("a fresh copy's text is in the decode memo, equal to the text packed, Latin-1 and not (D1913)", () => {
    for (const text of [longText("x").replace(/[^\x00-\xff]/g, "-"), longText("y")]) {
      clearDecoded();
      const packed = packItem(item("fresh", text));
      expect(isPacked(packed)).toBe(true);
      expect(decodedCount()).toBe(1);
      expect(packed.text).toBe(text);
      expect(packedOf(packed)!.latin1).toBe(!/[^\x00-\xff]/.test(text));
    }
  });
});

describe("a packed copy reads one text, from the memo or inflated (the review of D1913)", () => {
  // Random texts long enough to pack, from pieces that decide the encoding and what a decode could change: a leading
  // byte order mark (TextDecoder drops one unless told not to), lone and paired surrogates, Latin-1 and two-byte
  // characters, and plain ASCII.
  const PIECES = ["﻿", "\ud800", "\udc00", "😀", "é", "ß", "→", "—", "東京", "plain words ", "\n", "ÿ"];
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

  test.each(["zstd", "deflate"])(
    "the memo's read equals a real decode's; a copy reads the text packed (%s)",
    (codec) => {
      const r = rng(19130);
      let packed = 0;
      let boms = 0;
      for (let i = 0; i < 3_000; i++) {
        let text = r() < 0.2 ? "﻿" : "";
        while (text.length < MIN_PACK_CHARS * 2) {
          const p = PIECES[Math.floor(r() * PIECES.length)]!;
          // Mostly words, so most texts compress and pack; the odd pieces in between.
          text += r() < 0.7 ? "the meeting moved to Friday at noon " : p;
        }
        const raw = item(`r${i}`, text);
        const copy = codec === "zstd" ? packItem(raw) : deflatePacked(raw);
        const fromMemo = copy.text;
        clearDecoded();
        const inflated = copy.text;
        expect(fromMemo).toBe(inflated);
        if (isPacked(copy)) {
          packed++;
          if (text.charCodeAt(0) === 0xfeff) boms++;
          expect(inflated).toBe(text);
          expect(packedOf(copy)!.tag >> 1).toBe(codec === "zstd" ? 1 : 0);
          expect(packedOf(copy)!.latin1).toBe(!/[^\x00-\xff]/.test(text));
        }
      }
      // The run reached packed copies, BOM-led ones among them.
      expect(packed).toBeGreaterThan(1_000);
      expect(boms).toBeGreaterThan(100);
    },
  );
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

test("the decode memo keeps encodings apart: Latin-1 and UTF-8 texts with the same bytes read as themselves (D998)", () => {
  // "é" in UTF-8 is the bytes C3 A9, which read as Latin-1 are "Ã©"; the arrow's UTF-8 bytes E2 86 92 likewise. The two
  // texts deflate to the same bytes, and each item must still read its own text whichever was decoded first.
  const utf8 = "é".repeat(MIN_PACK_CHARS) + "→";
  const latin1 = "Ã©".repeat(MIN_PACK_CHARS) + "â\u0086\u0092";
  const a = packItem(item("a", latin1));
  const b = packItem(item("b", utf8));
  expect(Buffer.from(packedOf(a)!.bytes).equals(Buffer.from(packedOf(b)!.bytes))).toBe(true);
  expect(a.text).toBe(latin1);
  expect(b.text).toBe(utf8);
  expect(a.text).toBe(latin1);
});
