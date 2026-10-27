import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import { ItemCache } from "./cache";
import { termIds } from "./text";

const alice = { tenantId: "t", userId: "alice" };
const item = (sourceId: string, ref: string, text: string): ContextItem => ({
  id: `${sourceId}:${ref}`,
  sourceId,
  ref,
  title: `Item ${ref}`,
  text,
});

describe("ItemCache bounds (branch review)", () => {
  test("forgetting a source leaves none of its terms in the user's vocabulary", () => {
    const cache = new ItemCache();
    cache.put(alice, [item("crm", "1", "Quentavious renewal notes"), item("mail", "2", "Globex renewal call")]);
    expect(cache.peekVocab(alice)!.lookup("quentavious")).toBeGreaterThanOrEqual(0);
    cache.forget(alice, "crm");
    expect(cache.peekVocab(alice)!.lookup("quentavious")).toBe(-1);
    // What is left still ranks.
    const q = termIds("globex renewal", cache.peekVocab(alice)!, false);
    expect(cache.search(alice, q.ids, q.n, 5).map((h) => h.item.id)).toEqual(["mail:2"]);
  });

  test("the vocabulary is rebuilt once it outgrows the live items", () => {
    const cache = new ItemCache({ maxItemsPerUser: 10 });
    for (let i = 0; i < 400; i++) {
      const words = Array.from({ length: 200 }, (_, j) => `w${i}x${j}`).join(" ");
      cache.put(alice, [item("db", String(i), `${words} shared`)]);
    }
    // 80,000 distinct terms went through; 10 items of ~201 terms each are live.
    expect(cache.peekVocab(alice)!.size).toBeLessThan(50_001 + 201);
    const q = termIds("shared", cache.peekVocab(alice)!, false);
    expect(cache.search(alice, q.ids, q.n, 20)).toHaveLength(10);
  });

  test("reading a user with no cache allocates nothing", () => {
    const cache = new ItemCache();
    expect(cache.peekVocab(alice)).toBeUndefined();
    expect(cache.search(alice, [1], 1, 5)).toEqual([]);
    expect(cache.userCount).toBe(0);
  });
});
