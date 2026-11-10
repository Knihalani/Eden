import { expect, test } from "bun:test";
import { Budget } from "@eden/llm";
import type { ContextItem } from "@eden/protocol";
import { CardEnricher, type Card, type CardMaker } from "./cards";

// `cardsLanes` (N4, D521, promoted by D522): one user's card calls run in up to N lanes while full batches wait,
// so a new user's backfill is read sooner. One lane is the enricher as it was.

const NOW = Date.parse("2026-10-27T09:00:00Z");
const CONSTRAINT: Card = { kind: "limit", actions: ["purchase"], entities: [], statement: "needs a signature" };

const item = (ref: string, body = `Spending over £5,000 must have a second signature, case ${ref}`): ContextItem => ({
  id: `mail:${ref}`,
  sourceId: "mail",
  ref,
  // The sentence key reads the title too: the twins below share one.
  title: body.includes("case") ? `Note ${ref}` : "Spending rule",
  text: `From: sam@elsewhere.org\n\n${body}`,
  updatedAt: NOW,
});

/** A maker whose calls stay open until released, so the test sees how many are in flight. */
class Gate implements CardMaker {
  batches: string[][] = [];
  open = 0;
  peak = 0;
  private waiting: (() => void)[] = [];
  async make(items: ContextItem[]) {
    this.batches.push(items.map((i) => i.ref));
    this.open++;
    this.peak = Math.max(this.peak, this.open);
    await new Promise<void>((done) => this.waiting.push(done));
    this.open--;
    return { cards: items.map(() => CONSTRAINT), costUsd: 0.001 };
  }
  /** Lets every call now in flight return, then yields so the lanes take their next batches. */
  async release() {
    for (const done of this.waiting.splice(0)) done();
    await new Promise((r) => setTimeout(r, 0));
  }
}

const enricher = (maker: CardMaker, lanes: number, limits = {}) => {
  const e = new CardEnricher({ maker, budget: new Budget(), now: () => NOW }, { batch: 2, ...limits });
  if (lanes > 1) e.lanes(lanes);
  return e;
};
const scope = { tenantId: "t", userId: "u" };
const refs = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`);
const settle = () => new Promise((r) => setTimeout(r, 0));

test("one lane: a call at a time, as without the trial", async () => {
  const maker = new Gate();
  const e = enricher(maker, 1);
  e.enqueue(
    scope,
    refs(6).map((r) => item(r)),
  );
  await settle();
  expect(maker.open).toBe(1);
  for (let i = 0; i < 3; i++) await maker.release();
  await e.idle();
  expect(maker.peak).toBe(1);
  expect(maker.batches).toEqual([
    ["r0", "r1"],
    ["r2", "r3"],
    ["r4", "r5"],
  ]);
});

test("three lanes: full batches waiting are sent beside the call in flight, the same batches", async () => {
  const maker = new Gate();
  const e = enricher(maker, 3);
  e.enqueue(
    scope,
    refs(10).map((r) => item(r)),
  );
  await settle();
  // Three of the five batches are in flight at once; the rest wait for a lane.
  expect(maker.open).toBe(3);
  expect(maker.batches).toEqual([
    ["r0", "r1"],
    ["r2", "r3"],
    ["r4", "r5"],
  ]);
  await maker.release();
  expect(maker.open).toBe(2);
  await maker.release();
  await e.idle();
  expect(maker.peak).toBe(3);
  expect(maker.batches.flat().sort()).toEqual(refs(10).sort());
  expect(maker.batches).toHaveLength(5);
  expect(e.stats.calls).toBe(5);
  expect(e.stats.carded).toBe(10);
  // Every item's card is held.
  expect(
    e.cardsOf(
      scope,
      refs(10).map((r) => `mail:${r}`),
      NOW + 1,
    ).size,
  ).toBe(10);
});

test("a queue shorter than two batches is read by one lane", async () => {
  const maker = new Gate();
  const e = enricher(maker, 4);
  e.enqueue(
    scope,
    refs(3).map((r) => item(r)),
  );
  await settle();
  // The second batch is not full: it waits for the lane rather than taking a call of its own early.
  expect(maker.open).toBe(1);
  await maker.release();
  await maker.release();
  await e.idle();
  expect(maker.batches).toEqual([["r0", "r1"], ["r2"]]);
});

test("an item saying what another lane's batch in flight says waits for that card, with no call of its own", async () => {
  const maker = new Gate();
  const e = enricher(maker, 2, { sentenceReuse: true });
  const same = "Spending over £5,000 must have a second signature";
  // a and its twin say the same sentence; the twin falls in the second lane's batch.
  e.enqueue(scope, [
    item("a", `${same}.\n\nThanks, Sam`),
    item("b"),
    item("c"),
    item("twin", `Hi,\n\n${same}.`),
    item("d"),
  ]);
  await settle();
  expect(maker.batches).toEqual([
    ["a", "b"],
    ["c", "d"],
  ]);
  await maker.release();
  await maker.release();
  await e.idle();
  expect(maker.batches.flat()).not.toContain("twin");
  expect(e.stats.sentenceReused).toBe(1);
  expect(e.cardsOf(scope, ["mail:twin"], NOW + 1).size).toBe(1);
});

test("the lanes share one budget: a refused call sends nothing more", async () => {
  const maker = new Gate();
  const budget = new Budget({ callsPerSession: 100, usdPerSession: 1, usdPerUserDay: 0.004 });
  const e = new CardEnricher({ maker, budget, now: () => NOW }, { batch: 2, estimatedCallUsd: 0.002 });
  e.lanes(4);
  e.enqueue(
    scope,
    refs(10).map((r) => item(r)),
  );
  await settle();
  // Two reservations of $0.002 fit the day's $0.004; the third lane is refused and what waits is dropped.
  expect(maker.open).toBe(2);
  await maker.release();
  await e.idle();
  expect(maker.batches).toHaveLength(2);
  expect(e.stats.overBudget).toBeGreaterThan(0);
});

test("each user has their own lanes", async () => {
  const maker = new Gate();
  const e = enricher(maker, 2);
  e.enqueue(
    { tenantId: "t", userId: "a" },
    refs(6).map((r) => item(`a${r}`)),
  );
  e.enqueue(
    { tenantId: "t", userId: "b" },
    refs(6).map((r) => item(`b${r}`)),
  );
  await settle();
  expect(maker.open).toBe(4);
  for (let i = 0; i < 3; i++) await maker.release();
  await e.idle();
  expect(e.cardsOf({ tenantId: "t", userId: "a" }, ["mail:ar0", "mail:br0"], NOW + 1).size).toBe(1);
  expect(e.cardsOf({ tenantId: "t", userId: "b" }, ["mail:ar0", "mail:br0"], NOW + 1).size).toBe(1);
});

// N4's review: regressions and the failure paths.

test("an item queued in the hops between the last lane's end and the drain's are read, not stranded", async () => {
  for (const lanes of [1, 4]) {
    for (let hops = 1; hops <= 6; hops++) {
      const maker = new Gate();
      const e = enricher(maker, lanes);
      e.enqueue(scope, [item("first")]);
      await settle();
      // Let the call return, then enqueue `hops` microtasks later: the drain is ending but still marked running.
      void maker.release();
      for (let i = 0; i < hops; i++) await Promise.resolve();
      e.enqueue(scope, [item("late")]);
      await settle();
      await maker.release();
      await e.idle();
      expect(e.cardsOf(scope, ["mail:first", "mail:late"], NOW + 1).size).toBe(2);
    }
  }
});

test("a follower of another lane's batch keeps its place when its own lane's call fails", async () => {
  const same = "Spending over £5,000 must have a second signature";
  let n = 0;
  const batches: string[][] = [];
  const maker: CardMaker = {
    async make(items) {
      batches.push(items.map((i) => i.ref));
      const mine = n++;
      await new Promise((r) => setTimeout(r, mine === 0 ? 5 : 1));
      // The second lane's call ([c, d]) fails while the first ([a, b]) is still in flight.
      if (mine === 1) throw new Error("boom");
      return { cards: items.map(() => CONSTRAINT), costUsd: 0 };
    },
  };
  const e = enricher(maker, 2, { sentenceReuse: true });
  e.enqueue(scope, [
    item("a", `${same}.\n\nThanks, Sam`),
    item("b"),
    item("c"),
    item("twin", `Hi,\n\n${same}.`),
    item("d"),
  ]);
  await e.idle();
  expect(batches.slice(0, 2)).toEqual([
    ["a", "b"],
    ["c", "d"],
  ]);
  expect(e.stats.failures).toBe(1);
  // The twin took a's card; it was neither dropped with the failed batch nor sent in a call of its own.
  expect(e.cardsOf(scope, ["mail:twin"], NOW + 1).size).toBe(1);
  expect(batches.flat()).not.toContain("twin");
});

test("a batch being sent again after a cut still holds its sentences: a twin in another lane waits", async () => {
  const same = "Spending over £5,000 must have a second signature";
  const batches: string[][] = [];
  const maker: CardMaker = {
    async make(items, _today, _signal, retry) {
      batches.push(items.map((i) => i.ref));
      const first = items[0]!.ref === "a";
      // [a, b] is cut off and sent again, slowly; the other lane's calls are quick.
      await new Promise((r) => setTimeout(r, first ? (retry ? 15 : 3) : 1));
      if (first && !retry) return { cards: items.map(() => null), costUsd: 0, truncated: true };
      return { cards: items.map(() => CONSTRAINT), costUsd: 0 };
    },
  };
  const e = enricher(maker, 2, { sentenceReuse: true });
  // Lane two reads [c, d], then [e, f] while the retry runs; the twin comes up then and must wait.
  e.enqueue(scope, [
    item("a", `${same}.\n\nThanks, Sam`),
    item("b"),
    item("c"),
    item("d"),
    item("e"),
    item("f"),
    item("twin", `Hi,\n\n${same}.`),
  ]);
  await e.idle();
  expect(batches.flat()).not.toContain("twin");
  expect(e.cardsOf(scope, ["mail:twin"], NOW + 1).size).toBe(1);
});

test("a user forgotten while lanes are in flight keeps nothing, and the lanes end", async () => {
  const maker = new Gate();
  const e = enricher(maker, 3);
  e.enqueue(
    scope,
    refs(8).map((r) => item(r)),
  );
  await settle();
  expect(maker.open).toBe(3);
  e.forget(scope);
  await maker.release();
  await e.idle();
  expect(
    e.cardsOf(
      scope,
      refs(8).map((r) => `mail:${r}`),
      NOW + 1,
    ).size,
  ).toBe(0);
  // The two items still queued were dropped with the user: no call was made for them.
  expect(maker.batches).toHaveLength(3);
});

test("a maker that throws in every lane loses those batches only", async () => {
  let n = 0;
  const maker: CardMaker = {
    async make(items) {
      await Promise.resolve();
      if (n++ < 2) throw new Error("boom");
      return { cards: items.map(() => CONSTRAINT), costUsd: 0 };
    },
  };
  const e = enricher(maker, 2);
  e.enqueue(
    scope,
    refs(8).map((r) => item(r)),
  );
  await e.idle();
  expect(e.stats.failures).toBe(2);
  expect(
    e.cardsOf(
      scope,
      refs(8).map((r) => `mail:${r}`),
      NOW + 1,
    ).size,
  ).toBe(4);
});
