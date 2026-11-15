/**
 * The one MCP timer (D1840): deadlines fire as their own `setTimeout`s would, ties in the order added, cancelled
 * ones never, and nothing is held once none is pending.
 */
import { describe, expect, test } from "bun:test";
import { Deadlines } from "./deadlines";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const internals = (d: Deadlines) => d as unknown as { heap: unknown[]; timer: unknown; pending: number };

describe("Deadlines", () => {
  test("fire at their time, in due order, ties in the order added; a cancelled one never", async () => {
    const d = new Deadlines();
    const fired: string[] = [];
    const t0 = performance.now();
    const at: Record<string, number> = {};
    const mark = (k: string) => () => {
      fired.push(k);
      at[k] = performance.now() - t0;
    };
    d.add(40, mark("c"));
    d.add(10, mark("a1"));
    d.add(10, mark("a2"));
    const x = d.add(20, mark("x"));
    d.add(25, mark("b"));
    d.cancel(x);
    d.cancel(x); // twice is nothing
    await sleep(80);
    expect(fired).toEqual(["a1", "a2", "b", "c"]);
    expect(at.a1!).toBeGreaterThanOrEqual(9);
    expect(at.b!).toBeGreaterThanOrEqual(24);
    expect(at.c!).toBeGreaterThanOrEqual(39);
    expect(internals(d).pending).toBe(0);
    expect(internals(d).timer).toBeUndefined();
  });

  test("a request's timeout added before its POST's, with the same delay, fires first", async () => {
    const d = new Deadlines();
    const fired: string[] = [];
    for (let i = 0; i < 50; i++) {
      d.add(15, () => fired.push(`request ${i}`));
      d.add(15, () => fired.push(`post ${i}`));
    }
    await sleep(50);
    expect(fired).toEqual(Array.from({ length: 50 }, (_, i) => [`request ${i}`, `post ${i}`]).flat());
  });

  test("with none pending the timer is cleared and the heap emptied; cancelled ones are compacted", async () => {
    const d = new Deadlines();
    const ds = Array.from({ length: 1_000 }, () => d.add(60_000, () => {}));
    expect(internals(d).timer).toBeDefined();
    for (const x of ds.slice(0, 900)) d.cancel(x);
    // Past half cancelled, the heap holds at most twice what is pending.
    expect(internals(d).heap.length).toBeLessThanOrEqual(2 * internals(d).pending);
    for (const x of ds.slice(900)) d.cancel(x);
    expect(internals(d).heap).toHaveLength(0);
    expect(internals(d).timer).toBeUndefined();
  });

  // A deadline that throws is reported as uncaught (bun:test fails the test on it, so it is not exercised here); the
  // loop catches it first, so the rest still fire.
  test("a deadline may add and cancel others as it fires", async () => {
    const d = new Deadlines();
    const fired: string[] = [];
    let later: ReturnType<Deadlines["add"]> | undefined;
    d.add(5, () => {
      fired.push("first");
      if (later) d.cancel(later);
      d.add(5, () => fired.push("added"));
    });
    d.add(5, () => fired.push("second"));
    later = d.add(8, () => fired.push("cancelled"));
    // Until "added" fires, not a fixed 40 ms, which a loaded machine overran (D1965). It is due 5 ms after "first"
    // fired, so at least 10 ms in: "cancelled" (8 ms) would have fired before it had the cancel not held.
    for (let i = 0; i < 400 && fired.length < 3; i++) await sleep(5);
    expect(fired).toEqual(["first", "second", "added"]);
    expect(internals(d).pending).toBe(0);
  });

  test("a delay below 1 ms, not a number or past 32 bits fires as setTimeout would, after about 1 ms", async () => {
    const d = new Deadlines();
    const fired: number[] = [];
    for (const ms of [0, -5, Number.NaN, 2 ** 40]) d.add(ms, () => fired.push(ms));
    // Until all four fire (a fixed 20 ms is overrun under load, D1965); one held at 2^40 ms would never fire.
    for (let i = 0; i < 400 && fired.length < 4; i++) await sleep(5);
    expect(fired).toHaveLength(4);
  });
});
