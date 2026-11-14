import { describe, expect, test } from "bun:test";
import { hashString } from "@eden/primitives";
import type { ContextItem } from "@eden/protocol";
import { isPacked, packItem } from "./packed-text";
import { itemReadings, timesOf } from "./partner";

/*
 * D1885: an item's version (its title and text hashed) and its times (`timesOf`) are read once per item object, and
 * again when a plain item's text or title changes in place. Every answer must be what reading it afresh gives.
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

const PIECES = ["Lunch moved to 3pm", "on 4 Oct", "Tuesday 9:30", "the freeze holds", "Zoë signs on Friday", "12 Nov"];
const text = (r: () => number, n: number) =>
  Array.from({ length: n }, () => PIECES[Math.floor(r() * PIECES.length)]!).join(". ");

describe("an item's version and times, once per item object (D1885)", () => {
  test("plain and packed items, edited in place or not, read as fresh", () => {
    const r = rng(1885);
    const items: ContextItem[] = [];
    for (let i = 0; i < 400; i++) {
      const it: ContextItem = { id: `m:${i}`, sourceId: "mail", ref: String(i), title: text(r, 1), text: text(r, 60) };
      // Over `MIN_PACK_CHARS`, so half are held deflated as the cache holds them.
      items.push(r() < 0.5 ? packItem(it) : it);
    }
    expect(items.filter(isPacked).length).toBeGreaterThan(100);
    for (let step = 0; step < 5_000; step++) {
      const it = items[Math.floor(r() * items.length)]!;
      // A packed item's text is a fixed getter; a plain one's may be edited in place.
      if (!isPacked(it) && r() < 0.1) it.text = text(r, 1 + Math.floor(r() * 60));
      if (r() < 0.05) it.title = text(r, 1);
      expect(itemReadings.versionOf(it)).toBe(hashString(`${it.title}\n${it.text}`, 0));
      expect(itemReadings.timesOfItem(it)).toEqual(timesOf(it));
    }
  });
});
