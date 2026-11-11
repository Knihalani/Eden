import { describe, expect, test } from "bun:test";
import { CircuitBreaker } from "./breaker";
import { Deadline } from "./deadline";
import { Gcra } from "./gcra";
import { Histogram, RollingHistogram } from "./histogram";
import { AimdLimiter } from "./limiter";
import { Singleflight } from "./singleflight";

describe("Deadline", () => {
  test("children never outlive the parent and abort with it", async () => {
    const parent = Deadline.after(1_000);
    const child = parent.child(5_000);
    expect(child.at).toBeLessThanOrEqual(parent.at);
    const short = parent.child(10);
    await expect(short.race(new Promise((r) => setTimeout(r, 200)))).rejects.toBeDefined();
    expect(short.expired).toBe(true);
    expect(parent.expired).toBe(false);
    const half = parent.fraction(0.5);
    expect(half.remaining()).toBeLessThanOrEqual(501);
  });

  test("a child is never later than its parent, even when the clock ticks between reads", () => {
    // A clock that moves 1 ms on every read: two reads inside child() would put the child 1 ms past its parent.
    let t = 1_000_000;
    const tick = () => t++;
    const parent = Deadline.after(1_000, undefined, tick);
    for (const ms of [5_000, 1_000, Infinity]) expect(parent.child(ms).at).toBeLessThanOrEqual(parent.at);
    expect(parent.fraction(1).at).toBeLessThanOrEqual(parent.at);
    // A shorter child is `ms` from the clock read it was made at.
    const before = t;
    const short = parent.child(10);
    expect(short.at).toBe(before + 10);
    // The child keeps the parent's clock: its next read is `now`.
    const now = t;
    expect(short.remaining()).toBe(short.at - now);
  });

  test("an unbounded deadline's children are unbounded and share its signal, with no timer", () => {
    const parent = Deadline.after(Infinity);
    for (const child of [parent.child(Infinity), parent.fraction(0.5)]) {
      expect(child.at).toBe(Infinity);
      // No timeout signal of its own: it is the parent's.
      expect(child.signal).toBe(parent.signal);
    }
    const bounded = parent.child(50);
    expect(bounded.at).toBeLessThan(Infinity);
    expect(bounded.signal).not.toBe(parent.signal);
  });
});

describe("Singleflight", () => {
  test("concurrent calls share one execution, result and error", async () => {
    const sf = new Singleflight<string, number>();
    let runs = 0;
    const fn = async () => {
      runs++;
      await Bun.sleep(10);
      return 42;
    };
    const results = await Promise.all([sf.run("k", fn), sf.run("k", fn), sf.run("other", fn)]);
    expect(results).toEqual([42, 42, 42]);
    expect(runs).toBe(2);
    const boom = () => Promise.reject(new Error("boom"));
    await expect(Promise.all([sf.run("e", boom), sf.run("e", boom)])).rejects.toThrow("boom");
    expect(sf.inFlight).toBe(0);
  });

  test("one waiter leaving does not cancel the call; the last one leaving does", async () => {
    const sf = new Singleflight<string, string>();
    let aborted = false;
    const fn = (signal: AbortSignal) =>
      new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => (aborted = true));
        setTimeout(() => resolve("done"), 30);
      });
    const a = new AbortController();
    const first = sf.run("k", fn, a.signal);
    const second = sf.run("k", fn);
    a.abort(new Error("caller gave up"));
    await expect(first).rejects.toThrow("caller gave up");
    expect(await second).toBe("done");
    expect(aborted).toBe(false);

    const b = new AbortController();
    const only = sf.run("k2", fn, b.signal);
    b.abort(new Error("gone"));
    await expect(only).rejects.toThrow("gone");
    expect(aborted).toBe(true);
  });
});

describe("Gcra", () => {
  test("allows the burst, then the rate, and honours a penalty", () => {
    let now = 0;
    const rl = new Gcra({ ratePerSec: 10, burst: 3, now: () => now });
    expect([rl.take("u"), rl.take("u"), rl.take("u")]).toEqual([0, 0, 0]);
    expect(rl.take("u")).toBeCloseTo(100);
    now = 100;
    expect(rl.take("u")).toBe(0);
    expect(rl.take("other")).toBe(0);
    rl.penalize("u", 5_000);
    now = 2_000;
    expect(rl.take("u")).toBeGreaterThan(2_900);
  });
  test("available counts what could go now, matches take, and records nothing", () => {
    let now = 0;
    const rl = new Gcra({ ratePerSec: 10, burst: 3, now: () => now });
    expect(rl.available("u")).toBe(3);
    expect(rl.available("u")).toBe(3);
    rl.take("u");
    expect(rl.available("u")).toBe(2);
    rl.take("u");
    rl.take("u");
    expect(rl.available("u")).toBe(0);
    now = 100;
    expect(rl.available("u")).toBe(1);
    rl.penalize("u", 1_000);
    expect(rl.available("u")).toBe(0);
  });
});

describe("Gcra validation (finding 6)", () => {
  test("bad options throw; a cost above the burst never fits", () => {
    expect(() => new Gcra({ ratePerSec: 0, burst: 1 })).toThrow();
    expect(() => new Gcra({ ratePerSec: 1, burst: 0 })).toThrow();
    expect(new Gcra({ ratePerSec: 10, burst: 2 }).take("k", 3)).toBe(Infinity);
  });
});

describe("edge cases (finding 7)", () => {
  test("an infinite deadline never fires", () => {
    const d = Deadline.after(Infinity);
    expect(d.expired).toBe(false);
    expect(d.child(50).at).toBeLessThan(Infinity);
  });

  test("tryAcquire does not jump the queue", async () => {
    const l = new AimdLimiter({ initial: 1, min: 1, max: 1 });
    expect(l.tryAcquire()).toBe(true);
    const order: string[] = [];
    const waiting = l.acquire().then(() => order.push("waiter"));
    l.release("ok");
    expect(l.tryAcquire()).toBe(false);
    await waiting;
    expect(order).toEqual(["waiter"]);
  });

  test("an ignored outcome returns the permit and leaves the limit alone", () => {
    const l = new AimdLimiter({ initial: 4, min: 1, max: 8 });
    expect(l.tryAcquire()).toBe(true);
    const before = l.limit;
    l.release("ignored");
    expect(l.limit).toBe(before);
    expect(l.tryAcquire()).toBe(true);
  });
});

describe("CircuitBreaker", () => {
  test("opens on the failure rate, probes once when half-open, closes on success", () => {
    let now = 0;
    const b = new CircuitBreaker({ minCalls: 5, failureRate: 0.5, openMs: 1_000, now: () => now });
    for (let i = 0; i < 3; i++) b.success();
    for (let i = 0; i < 2; i++) b.failure();
    expect(b.state).toBe("closed"); // 2/5 failures
    b.failure();
    expect(b.state).toBe("open"); // 3/6
    expect(b.allow()).toBe(false);
    now = 1_000;
    expect([b.allow(), b.allow()]).toEqual([true, false]);
    b.success();
    expect(b.state).toBe("closed");
  });

  test("a probe that never reports does not hold the breaker half-open forever (finding 5)", () => {
    let now = 0;
    const b = new CircuitBreaker({ minCalls: 1, failureRate: 0.5, openMs: 1_000, now: () => now });
    b.failure();
    now = 1_000;
    expect(b.allow()).toBe(true); // the probe, whose caller then vanishes
    expect(b.allow()).toBe(false);
    now = 2_500;
    expect(b.allow()).toBe(true);
  });

  test("old failures fall out of the window", () => {
    let now = 0;
    const b = new CircuitBreaker({ windowMs: 10_000, minCalls: 5, now: () => now });
    for (let i = 0; i < 4; i++) b.failure();
    now = 20_000;
    b.failure();
    expect(b.state).toBe("closed");
  });
});

describe("AimdLimiter", () => {
  test("grows additively on success, shrinks multiplicatively on drops, queues waiters", async () => {
    const l = new AimdLimiter({ initial: 2, min: 1, max: 4 });
    expect([l.tryAcquire(), l.tryAcquire(), l.tryAcquire()]).toEqual([true, true, false]);
    const waiting = l.acquire();
    l.release("ok");
    await waiting;
    expect(l.inFlight).toBe(2);
    for (let i = 0; i < 20; i++) l.release("ok");
    expect(l.limit).toBe(4);
    l.release("dropped");
    expect(l.limit).toBe(3);
  });
});

describe("Histogram", () => {
  test("quantiles within ~3% on a known distribution", () => {
    const h = new Histogram();
    for (let i = 1; i <= 1_000; i++) h.record(i);
    expect(h.quantile(0.5) / 500).toBeCloseTo(1, 1);
    expect(h.quantile(0.99) / 990).toBeCloseTo(1, 1);
    expect(Math.abs(h.quantile(0.95) - 950) / 950).toBeLessThan(0.04);
  });

  test("the rolling window keeps the previous window and forgets older ones", () => {
    let now = 0;
    const r = new RollingHistogram(1_000, () => now);
    r.record(10);
    now = 1_500;
    r.record(1_000);
    expect(r.count).toBe(2);
    now = 5_000;
    expect(r.count).toBe(0);
  });
});

test("CircuitBreaker.idle: closed with nothing counted in its window (D754)", () => {
  let now = 1_000_000;
  const b = new CircuitBreaker({ windowMs: 60_000, minCalls: 5, failureRate: 0.5, openMs: 30_000, now: () => now });
  expect(b.idle).toBe(true);
  b.failure();
  expect(b.idle).toBe(false);
  now += 50_000;
  expect(b.idle).toBe(false);
  // The window has run out (it is counted in buckets of a tenth, as `failure` reads it): a new breaker would count
  // what this one does.
  now += 12_000;
  expect(b.idle).toBe(true);
  for (let i = 0; i < 5; i++) b.failure();
  expect(b.state).toBe("open");
  now += 10 * 60_000;
  // Half-open, not closed: its next call is a probe, which a new breaker's would not be.
  expect(b.idle).toBe(false);
  expect(b.allow()).toBe(true);
  b.success();
  expect(b.state).toBe("closed");
  expect(b.idle).toBe(true);
});
