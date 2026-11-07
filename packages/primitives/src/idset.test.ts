import { describe, expect, test } from "bun:test";
import { IdSet } from "./idset";
import { Xoshiro128 } from "./random";

/** Ids that cover the encoding: plain ASCII, Latin-1, the escape byte itself (ÿ), wider code units, the empty id. */
const pick = (r: Xoshiro128, n: number): string => {
  const k = Math.floor(r.uniform() * n);
  const kind = k % 7;
  if (kind === 0) return `mail:msg-${k}`;
  if (kind === 1) return `café-${k}`;
  if (kind === 2) return `ÿ${k}ÿ`;
  if (kind === 3) return `日本-${k}-\u{1F600}`;
  if (kind === 4) return k % 49 === 4 ? "" : `docs:${"x".repeat(k % 40)}${k}`;
  if (kind === 5) return `Āÿǿ${k}`;
  return `cal:${k}`;
};

describe("IdSet", () => {
  test("matches Set<string> through random adds, deletes, re-adds and clears", () => {
    for (const seed of [1, 2, 3]) {
      const r = new Xoshiro128(seed);
      const a = new IdSet();
      const b = new Set<string>();
      for (let step = 0; step < 20_000; step++) {
        const x = r.uniform();
        const id = pick(r, 600);
        if (x < 0.5) {
          a.add(id);
          b.add(id);
        } else if (x < 0.85) {
          expect(a.delete(id)).toBe(b.delete(id));
        } else if (x < 0.9995) {
          expect(a.has(id)).toBe(b.has(id));
        } else {
          a.clear();
          b.clear();
        }
        expect(a.size).toBe(b.size);
        if (step % 997 === 0) expect([...a]).toEqual([...b]);
      }
      expect([...a]).toEqual([...b]);
    }
  });

  test("a re-add after delete moves the id to the end; a re-add while present does not", () => {
    const a = new IdSet().add("x").add("y").add("z");
    a.add("x");
    expect([...a]).toEqual(["x", "y", "z"]);
    a.delete("x");
    a.add("x");
    expect([...a]).toEqual(["y", "z", "x"]);
  });

  test("deleting while iterating skips the deleted, as Set does (the sync's trim)", () => {
    const a = new IdSet();
    const b = new Set<string>();
    for (let i = 0; i < 1_000; i++) {
      a.add(`id-${i}`);
      b.add(`id-${i}`);
    }
    for (const s of [a, b]) {
      for (const id of s) {
        if (s.size <= 300) break;
        s.delete(id);
        s.delete(`id-${999 - Number(id.slice(3))}`);
      }
    }
    expect([...a]).toEqual([...b]);
    // Then grows again past the deleted half: compaction runs and keeps the order.
    for (let i = 1_000; i < 3_000; i++) {
      a.add(`id-${i}`);
      b.add(`id-${i}`);
    }
    expect([...a]).toEqual([...b]);
  });

  test("adding while iterating visits the new ids and never compacts under the iterator", () => {
    const a = new IdSet();
    const b = new Set<string>();
    for (let i = 0; i < 64; i++) {
      a.add(`k${i}`);
      b.add(`k${i}`);
    }
    for (let i = 0; i < 48; i++) {
      a.delete(`k${i}`);
      b.delete(`k${i}`);
    }
    const seenA: string[] = [];
    const seenB: string[] = [];
    for (const [s, seen] of [
      [a, seenA],
      [b, seenB],
    ] as const) {
      for (const id of s) {
        seen.push(id);
        if (seen.length <= 200) s.add(`${id}+`);
      }
    }
    expect(seenA).toEqual(seenB);
    expect([...a]).toEqual([...b]);
  });

  test("long ids decode in chunks", () => {
    const long = "a".repeat(10_000) + "ā".repeat(5_000) + "ÿ";
    const a = new IdSet().add(long).add("b");
    expect(a.has(long)).toBe(true);
    expect([...a]).toEqual([long, "b"]);
  });

  test("holds far less than a Set of strings", () => {
    const a = new IdSet();
    for (let i = 0; i < 3_000; i++) a.add(`mail:u12-${i}`);
    expect(a.bytesHeld / 3_000).toBeLessThan(48);
  });
});

test("past 65,534 slots the table widens and keeps every id", () => {
  const a = new IdSet();
  for (let i = 0; i < 70_000; i++) a.add(`w${i}`);
  for (let i = 0; i < 70_000; i += 2) a.delete(`w${i}`);
  for (let i = 70_000; i < 140_000; i++) a.add(`w${i}`);
  for (let i = 0; i < 140_000; i++) if (a.has(`w${i}`) !== (i >= 70_000 || i % 2 === 1)) throw new Error(`w${i}`);
  expect(a.size).toBe(35_000 + 70_000);
  expect(a.has("w0")).toBe(false);
  const all = [...a];
  expect(all[0]).toBe("w1");
  expect(all.at(-1)).toBe("w139999");
});
