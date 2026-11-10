/**
 * `SourceYield` (`sourceYield`, D505, a trial): each source's run of live reads with nothing used, and the user's
 * pooled rate for reads on weak evidence.
 */
import { describe, expect, test } from "bun:test";
import { POOL_WARMUP, SourceYield } from "./source-yield";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const T0 = Date.UTC(2026, 10, 10, 9);
const u1 = { tenantId: "t1", userId: "u1" };
const u2 = { tenantId: "t1", userId: "u2" };
const other = { tenantId: "t2", userId: "u1" };
const named = () => 2 as const;
const blind = () => 0 as const;
const words = () => 1 as const;

describe("SourceYield", () => {
  test("a source's run grows with each read, ends when an item of it is used, and halves in a half-life", () => {
    const y = new SourceYield(WEEK);
    expect(y.run(u1, "jira", T0)).toBe(0);
    y.read(u1, ["jira", "mail"], T0, named);
    y.read(u1, ["jira"], T0, named);
    expect(y.run(u1, "jira", T0)).toBe(2);
    expect(y.run(u1, "mail", T0)).toBe(1);
    expect(y.run(u1, "jira", T0 + WEEK)).toBeCloseTo(1, 6);
    y.read(u1, ["jira"], T0 + WEEK, named);
    expect(y.run(u1, "jira", T0 + WEEK)).toBeCloseTo(2, 6);
    y.used(u1, ["jira"], T0 + WEEK);
    expect(y.run(u1, "jira", T0 + WEEK)).toBe(0);
    expect(y.hasYielded(u1, "jira")).toBe(true);
    expect(y.hasYielded(u1, "mail")).toBe(false);
    // A read after a use starts a new run and keeps what the source earned.
    y.read(u1, ["jira"], T0 + WEEK, named);
    expect(y.run(u1, "jira", T0 + WEEK)).toBe(1);
    expect(y.hasYielded(u1, "jira")).toBe(true);
  });

  test("the pool is spent only after its warm-up, only while its reads do not pay, and per kind of evidence", () => {
    const y = new SourceYield(WEEK);
    const ids = Array.from({ length: 60 }, (_, k) => `noise-${k}`);
    y.read(u1, ids.slice(0, POOL_WARMUP - 1), T0, blind);
    expect(y.poolSpent(u1, 0, 0.05, T0)).toBe(false);
    y.read(u1, ids.slice(POOL_WARMUP - 1), T0, blind);
    // 60 reads on nothing, none used: surely under 5%.
    expect(y.poolSpent(u1, 0, 0.05, T0)).toBe(true);
    // Reads on words are another pool, and a floor of 0 turns the rule off.
    expect(y.poolSpent(u1, 1, 0.05, T0)).toBe(false);
    expect(y.poolSpent(u1, 0, 0, T0)).toBe(false);
    // Reads on a name are never pooled.
    y.read(u1, ids, T0, named);
    expect(y.poolSpent(u1, 1, 0.05, T0)).toBe(false);
    // Sources read on nothing that go on to be used are wins: with 12 of 60 the rate is not surely under 5%.
    y.used(u1, ids.slice(0, 12), T0);
    expect(y.poolSpent(u1, 0, 0.05, T0)).toBe(false);
  });

  test("a use counts once for each pool with a read of the source open, and never without one", () => {
    const y = new SourceYield(0);
    const ids = Array.from({ length: 60 }, (_, k) => `s-${k}`);
    y.read(u1, ids, T0, words);
    expect(y.poolSpent(u1, 1, 0.05, T0)).toBe(true);
    // A source used with no read open (its item came from the held copy) is no win for a pool.
    y.used(u1, ["held-only"], T0);
    expect(y.poolSpent(u1, 1, 0.05, T0)).toBe(true);
    y.used(u1, ids.slice(0, 10), T0);
    expect(y.poolSpent(u1, 1, 0.05, T0)).toBe(false);
    // Used again with no new read: not a second win.
    const before = y.poolSpent(u1, 1, 0.2, T0);
    y.used(u1, ids.slice(0, 10), T0);
    expect(y.poolSpent(u1, 1, 0.2, T0)).toBe(before);
  });

  test("a read of a source that has already earned its place is no evidence about the others", () => {
    const y = new SourceYield(WEEK);
    y.used(u1, ["mail", "crm"], T0);
    // Hundreds of reads on words of the sources the user does use, each used again: no read of the pool, no win.
    for (let i = 0; i < 100; i++) {
      y.read(u1, ["mail", "crm"], T0, words);
      y.used(u1, ["mail", "crm"], T0);
    }
    expect(y.poolSpent(u1, 1, 0.05, T0)).toBe(false);
    // The unused sources' reads alone fill the pool: 60 of them with nothing used spend it, whatever mail earned.
    y.read(
      u1,
      Array.from({ length: 60 }, (_, k) => `n-${k}`),
      T0,
      words,
    );
    expect(y.poolSpent(u1, 1, 0.05, T0)).toBe(true);
    expect(y.hasYielded(u1, "mail")).toBe(true);
  });

  test("the pool decays, so reads on no evidence resume", () => {
    const y = new SourceYield(WEEK);
    y.read(
      u1,
      Array.from({ length: 50 }, (_, k) => `n-${k}`),
      T0,
      blind,
    );
    expect(y.poolSpent(u1, 0, 0.05, T0)).toBe(true);
    // Two half-lives on: 12.5 reads are left, under the warm-up.
    expect(y.poolSpent(u1, 0, 0.05, T0 + 2 * WEEK)).toBe(false);
  });

  test("state is per tenant and user, and forget drops a source or the user", () => {
    const y = new SourceYield(WEEK);
    const ids = Array.from({ length: 60 }, (_, k) => `n-${k}`);
    y.read(u1, ids, T0, blind);
    y.used(u1, ["mail"], T0);
    expect(y.run(u2, "n-0", T0)).toBe(0);
    expect(y.run(other, "n-0", T0)).toBe(0);
    expect(y.poolSpent(u2, 0, 0.05, T0)).toBe(false);
    expect(y.poolSpent(other, 0, 0.05, T0)).toBe(false);
    expect(y.hasYielded(other, "mail")).toBe(false);
    expect(y.size(u2)).toBe(0);
    y.forget(u1, "n-0");
    expect(y.run(u1, "n-0", T0)).toBe(0);
    expect(y.run(u1, "n-1", T0)).toBe(1);
    y.forget(u1);
    expect(y.size(u1)).toBe(0);
    expect(y.poolSpent(u1, 0, 0.05, T0)).toBe(false);
    expect(y.hasYielded(u1, "mail")).toBe(false);
  });

  test("a user's sources are bounded: the least recently read is dropped", () => {
    const y = new SourceYield(WEEK);
    y.read(
      u1,
      Array.from({ length: 4_200 }, (_, k) => `s-${k}`),
      T0,
      named,
    );
    expect(y.size(u1)).toBe(4_096);
    expect(y.run(u1, "s-0", T0)).toBe(0);
    expect(y.run(u1, "s-4199", T0)).toBe(1);
  });
});
