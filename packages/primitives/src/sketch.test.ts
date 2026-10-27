import { describe, expect, test } from "bun:test";
import { mix32 } from "./hash";
import { ExpiringSet } from "./sketch";

describe("ExpiringSet", () => {
  test("a key is seen for `windows` windows after it was last added", () => {
    const s = new ExpiringSet(3, 8);
    s.add(1, 2);
    expect(s.has(1, 2)).toBe(true);
    s.rotate();
    s.rotate();
    expect(s.has(1, 2)).toBe(true);
    s.rotate();
    expect(s.has(1, 2)).toBe(false);
    expect(s.size).toBe(0);
  });

  test("adding again refreshes the key; size counts live keys once", () => {
    const s = new ExpiringSet(2, 8);
    s.add(7, 7);
    s.rotate();
    s.add(7, 7);
    expect(s.size).toBe(1);
    s.rotate();
    expect(s.has(7, 7)).toBe(true);
    s.rotate();
    expect(s.has(7, 7)).toBe(false);
  });

  test("one window: rotate forgets everything; keys with zero lanes work", () => {
    const s = new ExpiringSet(1, 4);
    s.add(0, 0);
    s.add(0xffffffff, 0);
    expect(s.has(0, 0)).toBe(true);
    expect(s.has(0xffffffff, 0)).toBe(true);
    expect(s.has(0, 0xffffffff)).toBe(false);
    s.rotate();
    expect(s.has(0, 0)).toBe(false);
    expect(s.size).toBe(0);
  });

  test("lanes are compared as unsigned (negative int32 input is the same key)", () => {
    const s = new ExpiringSet(2, 4);
    s.add(-1, -2);
    expect(s.has(0xffffffff, 0xfffffffe)).toBe(true);
  });

  test("agrees with a naive Map model under random adds, lookups and rotations (colliding slots, rebuilds)", () => {
    let x = 5;
    const rnd = (n: number) => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) % n;
    for (const windows of [1, 3, 7]) {
      const s = new ExpiringSet(windows, 2); // tiny: forces rebuilds and long probe runs
      const model = new Map<string, number>();
      let gen = 0;
      // Few distinct lo values so keys collide in the table; hi tells them apart.
      const key = () => [mix32(rnd(40)) & 0xff, rnd(500)] as const;
      for (let step = 0; step < 20_000; step++) {
        const op = rnd(20);
        const [lo, hi] = key();
        if (op < 9) {
          s.add(lo, hi);
          model.set(`${lo}:${hi}`, gen);
        } else if (op < 19) {
          const g = model.get(`${lo}:${hi}`);
          expect(s.has(lo, hi)).toBe(g !== undefined && g > gen - windows);
        } else {
          s.rotate();
          gen++;
        }
        if (step % 997 === 0) {
          let live = 0;
          for (const g of model.values()) if (g > gen - windows) live++;
          expect(s.size).toBe(live);
        }
      }
    }
  });

  test("the table shrinks back after a burst expires", () => {
    const s = new ExpiringSet(2, 16);
    for (let i = 0; i < 50_000; i++) s.add(mix32(i), i);
    const big = s.bytes;
    s.rotate();
    s.rotate(); // the burst has expired
    for (let i = 0; i < 2_000; i++) s.add(mix32(i + 1e6), i);
    for (let i = 0; i < 50_000; i++) s.add(mix32(i + 2e6), i); // triggers rebuilds that drop expired entries
    s.rotate();
    s.rotate();
    for (let i = 0; i < 100; i++) s.add(mix32(i + 3e6), i);
    expect(s.size).toBe(100);
    expect(s.bytes).toBeLessThanOrEqual(big * 2);
  });

  test("instances are independent (per user / per tenant state)", () => {
    const alice = new ExpiringSet(7, 16);
    const bob = new ExpiringSet(7, 16);
    alice.add(1, 1);
    expect(bob.has(1, 1)).toBe(false);
    bob.rotate();
    expect(alice.has(1, 1)).toBe(true);
  });

  test("windows must be at least 1", () => {
    expect(() => new ExpiringSet(0, 8)).toThrow(RangeError);
  });
});
