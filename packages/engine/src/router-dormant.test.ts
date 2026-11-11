/**
 * Trial `routerDormantMs` (M8, D943): a source on the weekly sweep of unused sources (D356) that the connector router
 * has not found likely for any request within `routerDormantMs` is swept that often instead. What keeps it safe is
 * D356's: a copy no sweep or read has vouched for within `syncSweepMs` is re-read before it is delivered or cited, so a
 * deletion the longer sweep has not seen is caught first; and a source whose integrator forwards change notices is
 * polled at its notice, dormant or not. A source the router finds likely keeps the weekly sweep.
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { CORE_CONFIG } from "./parts";
import { ContextPartner } from "./partner";
import { ROUTER_FEATURES, ROUTER_NF, ROUTER_NULL_NF, type RouterWeights } from "./router";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 20, 9);
const alice = { tenantId: "t1", userId: "alice" };
const bob = { tenantId: "t1", userId: "bob" };

class FetchSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  readonly fetchReportsGone = true;
  readonly fetchesById = true;
  notifies = false;
  lists = 0;
  fetches = 0;
  searches = 0;
  constructor(
    readonly id: string,
    public items: ContextItem[],
  ) {}
  async search(q: SearchQuery): Promise<ContextItem[]> {
    this.searches++;
    const words = q.text.toLowerCase().split(/\W+/).filter(Boolean);
    return this.items
      .filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)))
      .slice(0, q.limit);
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    this.lists++;
    const sorted = [...this.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
  async fetch(ref: string): Promise<ContextItem | null> {
    this.fetches++;
    return this.items.find((i) => i.ref === ref) ?? null;
  }
}

const item = (src: string, i: number, text: string, at = T0 - (i + 1) * HOUR): ContextItem => ({
  id: itemId(src, `i${i}`),
  sourceId: src,
  ref: `i${i}`,
  title: `${src} note ${i}`,
  text,
  updatedAt: at,
});

const ASKED = 15;
const REF = `i${ASKED}`;

/** A "bank" of 20 items (the one asked about far below its newest page) and three filler sources: four sources. */
function world() {
  const rows = Array.from({ length: 20 }, (_, i) =>
    item("bank", i, i === ASKED ? "isa allowance statement for this year" : `card fees ${i}`),
  );
  const bank = new FetchSource("bank", rows);
  const filler = [1, 2, 3].map((k) => new FetchSource(`src${k}`, [item(`src${k}`, 0, `filler sprint ${k}`)]));
  return { bank, all: [bank, ...filler] };
}

/**
 * Weights whose only input is the request's local matches: a source holding them is likely; any other is not
 * (`nothing needed` takes the rest), and the floor is 0.05.
 */
function weights(): RouterWeights {
  const w1 = new Float32Array(ROUTER_NF);
  w1[ROUTER_FEATURES.indexOf("local")] = 10;
  return {
    buckets: 4,
    conj: new Int8Array(4),
    conjScale: 0,
    hidden: 1,
    mu: new Float32Array(ROUTER_NF),
    sd: new Float32Array(ROUTER_NF).fill(1),
    w1,
    b1: new Float32Array(1),
    w2: new Float32Array([1]),
    b2: -1,
    nullBias: 3,
    nullW: new Float32Array(ROUTER_NULL_NF),
    temperature: 1,
    floor: 0.05,
  };
}

const DORMANT = 28 * DAY;

function setup(byUser: Map<string, Source[]>, config: Record<string, unknown>) {
  let clock = T0;
  const cache = new ItemCache();
  const partner = new ContextPartner({
    sources: async (scope) => byUser.get(scope.userId) ?? [],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache,
    budget: new Budget(),
    model: null,
    now: () => clock,
    router: weights(),
    config: {
      ...CORE_CONFIG,
      sync: true,
      syncOnDemand: true,
      verifyDelivery: true,
      syncPageSize: 10,
      syncCallsPerMin: 6_000,
      routeLocalHits: true,
      sourceYield: true,
      syncUnusedSweepMs: 7 * DAY,
      routerGate: true,
      ...config,
    },
  });
  return { partner, cache, advance: (ms: number) => (clock += ms), now: () => clock };
}

async function warm(partner: ContextPartner, scope: Scope): Promise<void> {
  partner.sync!.track(scope);
  for (let i = 0; i < 200 && !partner.sync!.warm(scope); i++) await partner.sync!.tick();
  expect(partner.sync!.warm(scope)).toBe(true);
}

/** `days` active days: the user is seen and the sync ticks every 10 minutes; `each` runs once a day. */
async function live(t: ReturnType<typeof setup>, scope: Scope, days: number, each?: () => Promise<unknown>) {
  for (let d = 0; d < days; d++) {
    if (each) await each();
    for (let k = 0; k < DAY / (10 * MIN); k++) {
      t.advance(10 * MIN);
      t.partner.sync!.track(scope, t.now());
      await t.partner.sync!.tick();
    }
  }
}

const cites = async (p: ContextPartner, scope: Scope, sessionId: string, question = "Have I used my isa allowance?") =>
  (await p.ask({ ...scope, sessionId, question })).citations.map((c) => c.itemId);

describe("routerDormantMs (D943)", () => {
  test("off: an unused source is swept weekly; on: one the router never found likely waits for the longer sweep", async () => {
    for (const on of [false, true]) {
      const { all } = world();
      const t = setup(new Map([["alice", all]]), on ? { routerDormantMs: DORMANT } : {});
      await warm(t.partner, alice);
      const before = all.map((s) => s.lists);
      await live(t, alice, 9);
      const swept = all.map((s, k) => s.lists - before[k]!);
      for (const n of swept)
        if (on) expect(n).toBe(0);
        else expect(n).toBeGreaterThanOrEqual(1);
    }
  });

  test("a source the router finds likely for a request keeps its weekly sweep", async () => {
    const { bank, all } = world();
    // No on-demand poll, so a source's listings are its sweeps (the asks' lookups read the copies as held).
    const t = setup(new Map([["alice", all]]), { routerDormantMs: DORMANT, syncOnDemand: false });
    await warm(t.partner, alice);
    const before = all.map((s) => s.lists);
    let n = 0;
    // A request a day that the bank's held items match: the router finds the bank likely, the fillers not.
    await live(t, alice, 9, () => t.partner.ask({ ...alice, sessionId: `d${n++}`, question: "card fees this month" }));
    expect(bank.lists - before[0]!).toBeGreaterThanOrEqual(1);
    for (let k = 1; k < all.length; k++) expect(all[k]!.lists - before[k]!).toBe(0);
  });

  test("a deletion in a dormant source is caught by the re-read before the ask cites it", async () => {
    const { bank, all } = world();
    const t = setup(new Map([["alice", all]]), { routerDormantMs: DORMANT });
    await warm(t.partner, alice);
    await live(t, alice, 10);
    // Deleted at the source, the integrator's notice lost; no sweep has run since the backfill, so the copy is in
    // doubt (D356's rule): a delivery or citation re-reads it first.
    expect(t.partner.sync!.sweepLapsed(alice, "bank", t.now())).toBe(true);
    bank.items = bank.items.filter((i) => i.ref !== REF);
    const reads = bank.fetches + bank.searches + bank.lists;
    expect(await cites(t.partner, alice, "s1")).not.toContain(itemId("bank", REF));
    // Caught by a read of the source (a re-read by ref, or the live read of a copy no longer current).
    expect(bank.fetches + bank.searches + bank.lists).toBeGreaterThan(reads);
  });

  test("a dormant source's synced copy lapses at the synced items' 7-day life: deletion lag is not longer", async () => {
    const { all } = world();
    const t = setup(new Map([["alice", all]]), { routerDormantMs: DORMANT });
    await warm(t.partner, alice);
    await live(t, alice, 6);
    expect(t.cache.get(alice, itemId("bank", REF), t.now())).not.toBeNull();
    await live(t, alice, 2);
    // Not listed again for 8 days (no sweep, no poll past its newest page): no longer held, so nothing deleted at the
    // source can be delivered from it; a request the router finds it likely for reads it live.
    expect(t.cache.get(alice, itemId("bank", REF), t.now())).toBeNull();
  });

  test("an item changed in a dormant source is re-read and handed as it is now, not as held", async () => {
    const { bank, all } = world();
    const t = setup(new Map([["alice", all]]), { routerDormantMs: DORMANT });
    await warm(t.partner, alice);
    await live(t, alice, 10);
    const at = bank.items.findIndex((i) => i.ref === REF);
    bank.items[at] = { ...bank.items[at]!, text: "isa allowance statement for this year: allowance fully used" };
    const reply = await t.partner.ask({ ...alice, sessionId: "s1", question: "Have I used my isa allowance?" });
    expect(reply.citations.map((c) => c.itemId)).toContain(itemId("bank", REF));
    expect(reply.answer).toContain("fully used");
  });

  test("a dormant source whose integrator forwards notices is polled at its notice", async () => {
    const { bank, all } = world();
    bank.notifies = true;
    const t = setup(new Map([["alice", all]]), { routerDormantMs: DORMANT, syncPush: true });
    await warm(t.partner, alice);
    await live(t, alice, 10);
    bank.items.push(item("bank", 99, "isa allowance raised to the new limit", t.now() - MIN));
    expect(t.partner.sourceChanged(alice, "bank")).toBe(true);
    const reads = bank.lists + bank.searches;
    const got = await cites(t.partner, alice, "s1", "isa allowance raised");
    expect(bank.lists + bank.searches).toBeGreaterThan(reads);
    expect(got).toContain(itemId("bank", "i99"));
  });

  test("dormancy is per user: a source one user's requests find likely is dormant for another", async () => {
    const { bank: a, all: forA } = world();
    const { bank: b, all: forB } = world();
    const t = setup(
      new Map([
        ["alice", forA],
        ["bob", forB],
      ]),
      { routerDormantMs: DORMANT, syncOnDemand: false },
    );
    await warm(t.partner, alice);
    await warm(t.partner, bob);
    const before = [a.lists, b.lists];
    let n = 0;
    for (let d = 0; d < 9; d++) {
      await t.partner.ask({ ...alice, sessionId: `a${n++}`, question: "card fees this month" });
      for (let k = 0; k < DAY / (10 * MIN); k++) {
        t.advance(10 * MIN);
        t.partner.sync!.track(alice, t.now());
        t.partner.sync!.track(bob, t.now());
        await t.partner.sync!.tick();
      }
    }
    expect(a.lists - before[0]!).toBeGreaterThanOrEqual(1);
    expect(b.lists - before[1]!).toBe(0);
  });
});
