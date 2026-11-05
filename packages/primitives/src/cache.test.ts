import { describe, expect, test } from "bun:test";
import { S3FifoCache } from "./cache";
import { TopK } from "./topk";

describe("S3FifoCache", () => {
  test("respects the byte budget and never admits an entry larger than it", () => {
    const c = new S3FifoCache<string, string>({ maxBytes: 100 });
    for (let i = 0; i < 50; i++) c.set(`k${i}`, "v", 10);
    expect(c.bytes).toBeLessThanOrEqual(100);
    c.set("huge", "v", 101);
    expect(c.get("huge")).toBeUndefined();
  });

  test("a key read while in the small queue survives a scan of one-hit wonders", () => {
    const c = new S3FifoCache<string, number>({ maxBytes: 20 });
    c.set("hot", 1);
    c.get("hot");
    for (let i = 0; i < 200; i++) c.set(`scan${i}`, i);
    expect(c.get("hot")).toBe(1);
  });

  test("a recently evicted key that returns goes to main via the ghost", () => {
    const c = new S3FifoCache<string, number>({ maxBytes: 10 });
    c.set("a", 1);
    for (let i = 0; i < 10; i++) c.set(`x${i}`, i); // overflows the budget: "a" leaves small for the ghost
    expect(c.get("a")).toBeUndefined();
    c.set("a", 2);
    for (let i = 0; i < 9; i++) c.set(`y${i}`, i);
    expect(c.get("a")).toBe(2);
  });

  test("stale-while-revalidate: stale values are served and flagged, expired ones are gone", () => {
    let now = 0;
    const c = new S3FifoCache<string, string>({
      maxBytes: 10,
      staleAfterMs: 100,
      expireAfterMs: 1_000,
      now: () => now,
    });
    c.set("k", "v");
    expect([c.get("k"), c.isStale("k"), c.peek("k")]).toEqual(["v", false, "v"]);
    now = 500;
    expect([c.get("k"), c.isStale("k"), c.peek("k")]).toEqual(["v", true, undefined]);
    now = 1_000;
    expect(c.get("k")).toBeUndefined();
    expect(c.size).toBe(0);
  });

  test("updates adjust bytes; delete and deleteWhere remove; slots are reused without corruption", () => {
    const c = new S3FifoCache<string, number>({ maxBytes: 1_000 });
    c.set("a", 1, 10);
    c.set("a", 2, 30);
    expect([c.get("a"), c.bytes]).toEqual([2, 30]);
    expect(c.delete("a")).toBe(true);
    expect(c.bytes).toBe(0);
    for (let round = 0; round < 50; round++) {
      for (let i = 0; i < 40; i++) c.set(`u${round % 3}/k${i}`, i, 7);
      c.deleteWhere((k) => k.startsWith(`u${(round + 1) % 3}/`));
    }
    for (const [k, v] of [
      ["u1/k5", 5],
      ["u1/k39", 39],
    ] as const)
      expect([undefined, v as number]).toContain(c.get(k));
    expect(c.bytes).toBeLessThanOrEqual(1_000);
  });
});

describe("S3FifoCache review regressions", () => {
  test("delete and TTL churn under budget keep memory proportional to live entries (finding 1)", () => {
    const c = new S3FifoCache<number, number>({ maxBytes: 100 });
    for (let i = 0; i < 200_000; i++) {
      c.set(i, i);
      c.delete(i);
    }
    expect(c.size).toBe(0);
    expect(c.slotCount).toBeLessThan(1_000);
    let now = 0;
    const t = new S3FifoCache<number, number>({ maxBytes: 100, expireAfterMs: 1, now: () => now });
    for (let i = 0; i < 100_000; i++) {
      t.set(i, i);
      now += 2;
      t.get(i);
    }
    expect(t.slotCount).toBeLessThan(1_000);
  });

  test("an oversized overwrite removes the old value instead of serving it (finding 2)", () => {
    const c = new S3FifoCache<string, string>({ maxBytes: 10 });
    c.set("a", "old", 5);
    c.set("a", "new", 50);
    expect(c.get("a")).toBeUndefined();
    expect(c.bytes).toBe(0);
  });

  test("huge byte costs do not wrap around", () => {
    const c = new S3FifoCache<string, string>({ maxBytes: 1_000 });
    c.set("big", "v", 3e9);
    expect(c.get("big")).toBeUndefined();
  });
});

describe("S3FifoCache groups", () => {
  const groupOf = (k: string) => k.slice(0, k.indexOf("/"));

  test("deleteGroup removes exactly one group's live entries", () => {
    const c = new S3FifoCache<string, number>({ maxBytes: 1_000, group: groupOf });
    for (const g of ["a", "b", "ab"]) for (let i = 0; i < 5; i++) c.set(`${g}/${i}`, i);
    expect(c.deleteGroup("a")).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(c.get(`a/${i}`)).toBeUndefined();
      expect(c.get(`b/${i}`)).toBe(i);
      expect(c.get(`ab/${i}`)).toBe(i);
    }
    expect(c.deleteGroup("a")).toBe(0);
    expect(c.deleteGroup("missing")).toBe(0);
    expect(c.size).toBe(10);
    expect(c.groupCount).toBe(2);
    // The group comes back with new keys after its drop.
    c.set("a/9", 9);
    expect(c.get("a/9")).toBe(9);
    expect(c.deleteGroup("a")).toBe(1);
  });

  test("keys leaving by delete, expiry, eviction and an oversized replace leave their group too (no leak)", () => {
    let now = 0;
    const c = new S3FifoCache<string, number>({ maxBytes: 50, expireAfterMs: 10, now: () => now, group: groupOf });
    c.set("d/1", 1);
    expect(c.delete("d/1")).toBe(true);
    c.set("x/1", 1);
    now = 20;
    expect(c.get("x/1")).toBeUndefined(); // expired
    c.set("o/1", 1);
    c.set("o/1", 2, 500); // larger than the cache: removed
    expect(c.groupCount).toBe(0);
    // Eviction: 10,000 groups through a 50-entry cache, some read so they go through main.
    for (let i = 0; i < 10_000; i++) {
      c.set(`g${i}/k`, i);
      if (i % 3 === 0) c.get(`g${i}/k`);
    }
    expect(c.size).toBeLessThanOrEqual(50);
    expect(c.groupCount).toBe(c.size);
    const held = c.size;
    let removed = 0;
    for (let i = 0; i < 10_000; i++) removed += c.deleteGroup(`g${i}`);
    expect(removed).toBe(held);
    expect(c.size).toBe(0);
    expect(c.groupCount).toBe(0);
  });

  test("replacing a key keeps it in its group once; slots reused after a group drop are not corrupted", () => {
    const c = new S3FifoCache<string, number>({ maxBytes: 1_000, group: groupOf });
    for (let round = 0; round < 200; round++) {
      for (let i = 0; i < 10; i++) c.set(`u${round % 4}/${i}`, round);
      for (let i = 0; i < 10; i++) c.set(`u${round % 4}/${i}`, round + 1); // replace
      expect(c.deleteGroup(`u${(round + 1) % 4}`)).toBe(round >= 3 ? 10 : 0);
    }
    expect(c.size).toBe(30);
    expect(c.groupCount).toBe(3);
    expect(c.get("u3/0")).toBe(200);
  });

  test("deleteGroup without a group function throws (a caller bug, not a silent no-op)", () => {
    const c = new S3FifoCache<string, number>({ maxBytes: 10 });
    expect(() => c.deleteGroup("a")).toThrow();
  });
});

describe("TopK", () => {
  test("keeps the k best, drains best first, and exposes the entry floor", () => {
    const t = new TopK(3);
    for (const [id, s] of [
      [1, 0.5],
      [2, 0.9],
      [3, 0.1],
      [4, 0.7],
      [5, 0.95],
      [6, 0.2],
    ])
      t.push(id!, s!);
    expect(t.floor).toBeCloseTo(0.7);
    const ids = new Int32Array(3);
    const scores = new Float64Array(3);
    expect(t.drain(ids, scores)).toBe(3);
    expect([...ids]).toEqual([5, 2, 4]);
    expect([...scores]).toEqual([0.95, 0.9, 0.7]);
    expect(t.size).toBe(0);
  });

  test("NaN scores never enter", () => {
    const t = new TopK(2);
    t.push(1, NaN);
    t.push(2, 1);
    t.push(3, 2);
    t.push(4, NaN);
    const ids: number[] = [];
    t.drain(ids, null);
    expect(ids).toEqual([3, 2]);
  });

  test("matches a full sort on random input", () => {
    let x = 3;
    const rnd = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
    for (const k of [1, 5, 32]) {
      const items = Array.from({ length: 500 }, (_, id) => ({ id, s: rnd() }));
      const t = new TopK(k);
      for (const it of items) t.push(it.id, it.s);
      const ids: number[] = [];
      t.drain(ids, null);
      expect(ids).toEqual(
        [...items]
          .sort((a, b) => b.s - a.s)
          .slice(0, k)
          .map((it) => it.id),
      );
    }
  });
});

describe("TopK.pushDense", () => {
  test("equals per-candidate pushes and honours minScore", () => {
    const scores = Float64Array.from({ length: 1_000 }, (_, i) => Math.sin(i * 7));
    const a = new TopK(8);
    const b = new TopK(8);
    for (let i = 0; i < scores.length; i++) if (scores[i]! > 0.5) a.push(i, scores[i]!);
    b.pushDense(scores, 0, scores.length, 0.5);
    const ia: number[] = [];
    const ib: number[] = [];
    a.drain(ia, null);
    b.drain(ib, null);
    expect(ib).toEqual(ia);
  });
});
