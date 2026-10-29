/**
 * Regressions from the 2026-10-29 audit of the primitives: each test failed before its fix.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { BetaBandit } from "./bandit";
import { CircuitBreaker } from "./breaker";
import { Isotonic } from "./calibrate";
import { Deadline } from "./deadline";
import { Gcra } from "./gcra";
import { MultiMatcher } from "./matcher";
import { WorkerPool } from "./pool";
import { Xoshiro128 } from "./random";
import { SparseIndex } from "./sparse-index";

describe("SparseIndex", () => {
  test("a doc matching 256 or more query terms is returned once, its matched count saturating at 255", () => {
    const idx = new SparseIndex();
    idx.add(
      Uint32Array.from({ length: 300 }, (_, i) => i),
      300,
    );
    idx.add(Uint32Array.from([1000, 1001]), 2);
    for (const n of [256, 257]) {
      const r = idx.search(
        Uint32Array.from({ length: n }, (_, i) => i),
        n,
        10,
      );
      expect(Array.from(r.docs)).toEqual([0]);
      expect(r.matched[0]).toBe(255);
    }
  });

  test("a term held in two fields counts once, even after 2^31 query terms", () => {
    const idx = new SparseIndex({ fields: 2 });
    idx.addFields([Uint32Array.from([7]), Uint32Array.from([7])], [1, 1]);
    idx.addFields([Uint32Array.from([8]), Uint32Array.from([9])], [1, 1]);
    (idx as unknown as { queryNo: number }).queryNo = 2 ** 31 - 1;
    let r = idx.search(Uint32Array.from([7]), 1, 5);
    expect(r.matched[0]).toBe(1);
    expect(r.coverage[0]).toBeCloseTo(1, 5);
    (idx as unknown as { queryNo: number }).queryNo = 2 ** 32 - 2; // near the Uint32 wrap: stamps reset
    r = idx.search(Uint32Array.from([7, 7]), 2, 5);
    expect(r.matched[0]).toBe(1);
    expect(r.coverage[0]).toBeCloseTo(1, 5);
  });
});

describe("WorkerPool", () => {
  const pools: WorkerPool[] = [];
  afterEach(() => {
    for (const p of pools.splice(0)) p.close();
  });

  test("tasks aborted while waiting free their place in the queue", async () => {
    const p = await WorkerPool.start({
      module: new URL("./pool.fixture.ts", import.meta.url).href,
      size: 1,
      maxQueue: 2,
      maxBatch: 1,
      taskTimeoutMs: Infinity,
      inlineBelow: 0,
    });
    pools.push(p);
    const busy = p.run("spin", 300).catch(() => 0);
    await Bun.sleep(20);
    const c1 = new AbortController();
    const c2 = new AbortController();
    const w1 = p.run("double", 1, c1.signal).catch(() => "aborted");
    const w2 = p.run("double", 2, c2.signal).catch(() => "aborted");
    await Bun.sleep(10);
    c1.abort();
    c2.abort();
    expect(await w1).toBe("aborted");
    expect(await w2).toBe("aborted");
    expect(p.stats().queued).toBe(0);
    expect(await p.run<number>("double", 21)).toBe(42);
    await busy;
  });
});

describe("CircuitBreaker", () => {
  const tripped = (now: { t: number }) => {
    const b = new CircuitBreaker({ minCalls: 2, failureRate: 0.5, openMs: 1_000, now: () => now.t });
    const before = b.epoch;
    b.allow();
    b.allow();
    b.allow();
    b.failure(before);
    b.failure(before);
    return { b, before };
  };

  test("a late failure while open does not push the probe back", () => {
    const now = { t: 0 };
    const { b } = tripped(now);
    expect(b.state).toBe("open");
    now.t = 900;
    b.failure();
    now.t = 1_000;
    expect(b.state).toBe("half-open");
  });

  test("a report carrying a pre-trip epoch neither closes nor re-opens a half-open breaker", () => {
    const now = { t: 0 };
    const { b, before } = tripped(now);
    now.t = 1_000;
    expect(b.allow()).toBe(true);
    const probe = b.epoch;
    b.success(before);
    expect(b.state).toBe("half-open");
    b.failure(before);
    expect(b.state).toBe("half-open");
    b.success(probe);
    expect(b.state).toBe("closed");
  });
});

describe("small numeric edges", () => {
  test("Gcra.penalize ignores NaN and negative waits", () => {
    let now = 0;
    const g = new Gcra<string>({ ratePerSec: 1, burst: 1, now: () => now });
    g.penalize("k", Number.NaN);
    g.penalize("k", -5);
    let allowed = 0;
    for (let i = 0; i < 100; i++) if (g.take("k") === 0) allowed++;
    expect(allowed).toBe(1);
  });

  test("Deadline.fraction(0) of an unbounded deadline is expired, a positive share stays unbounded", () => {
    const d = Deadline.after(Infinity);
    expect(d.fraction(0).remaining()).toBe(0);
    expect(d.fraction(0.5).at).toBe(Infinity);
  });

  test("inclusionPropensity clamps k as select does", () => {
    const b = new BetaBandit(4, Float64Array.from([0.5, 0.5, 0.5, 0.5]), 4, 1, 1); // maxK 1
    const pi = new Float64Array(4);
    b.inclusionPropensity(new Xoshiro128(2), 2, null, null, 1, 100, pi);
    expect(pi[0]).toBeCloseTo(0.25, 5);
  });

  test("Isotonic merges tied scores before pooling: the order of tied labels does not matter", () => {
    const fit = (labels: number[]) => {
      const iso = new Isotonic();
      iso.fit(Float64Array.from([1, 1, 1, 1, 1, 2, 2]), Uint8Array.from(labels), 7, 0);
      return [iso.predict(1), iso.predict(2)];
    };
    const a = fit([1, 0, 0, 0, 0, 0, 1]);
    expect(a[0]).toBeCloseTo(0.2, 12);
    expect(a[1]).toBeCloseTo(0.5, 12);
    expect(fit([1, 0, 0, 0, 0, 1, 0])).toEqual(a);
  });
});

test("MultiMatcher reads a ligature in the text as its letters, as the tokenizer does", () => {
  expect(new MultiMatcher(["file"]).any("the ﬁle")).toBe(true);
  expect(new MultiMatcher(["the file"], { wholeWord: true }).any("see the ﬁle now")).toBe(true);
  expect(new MultiMatcher(["fi"], { wholeWord: true }).any("ﬁle")).toBe(false);
});
