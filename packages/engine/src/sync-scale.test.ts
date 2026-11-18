/**
 * The A1 scale switches on the background sync (docs/research/a1-scale.md): a user with many sources.
 * `syncBackfillLanes` (D262) changes how the backfill reads, not what it keeps; `syncPollWidth` (D263) bounds a
 * lookup's on-demand poll; `syncLocalComplete` (D264) searches live a source whose synced copy the user's cap cut.
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 9);
const scope = { tenantId: "t1", userId: "u1" };
/** Every A1 switch off (the pre-D262 sync); each test turns on what it measures. */
const OFF = {
  syncPollWidth: 0,
  syncBackfillLanes: 1,
  syncLocalComplete: false,
  routeLocalHits: false,
  // A13's (D320–D323), so these tests keep measuring the A1 switches alone.
  routeSketch: false,
  syncKeepCut: false,
  syncEngagedDeep: false,
  cardsSourceAware: false,
};

/** A recent-first listing source that counts its calls and how many are in flight at once. */
class ListSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  searches = 0;
  lists = 0;
  limits: number[] = [];
  static inFlight = 0;
  static maxInFlight = 0;
  constructor(
    readonly id: string,
    readonly items: ContextItem[],
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
    this.limits.push(limit);
    ListSource.maxInFlight = Math.max(ListSource.maxInFlight, ++ListSource.inFlight);
    await Bun.sleep(1);
    ListSource.inFlight--;
    const sorted = [...this.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
}

/** `n` sources of `per` items each; source k's item i is `k + n * i` hours old, so recency interleaves them. */
function many(n: number, per: number): ListSource[] {
  return Array.from(
    { length: n },
    (_, k) =>
      new ListSource(
        `src${k}`,
        Array.from({ length: per }, (_, i) => ({
          id: itemId(`src${k}`, `i${i}`),
          sourceId: `src${k}`,
          ref: `i${i}`,
          title: `Item ${k}-${i}`,
          text: `filler words for source ${k} item ${i}`,
          updatedAt: T0 - (k + n * i) * HOUR,
        })),
      ),
  );
}

function setup(sources: Source[], config: Record<string, unknown>, cache = new ItemCache()) {
  let clock = T0;
  const partner = new ContextPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache,
    budget: new Budget(),
    model: null,
    now: () => clock,
    config: { sync: true, syncPageSize: 10, syncPollPageSize: 2, syncCallsPerMin: 6_000, ...OFF, ...config },
  });
  return { partner, cache, advance: (ms: number) => (clock += ms), now: () => clock };
}

async function warm(partner: ContextPartner): Promise<void> {
  partner.sync!.track(scope);
  for (let i = 0; i < 200 && !partner.sync!.warm(scope); i++) await partner.sync!.tick();
  expect(partner.sync!.warm(scope)).toBe(true);
}

/** The ids the user's sync holds, sorted. */
function held(cache: ItemCache, sources: ListSource[]): string[] {
  return sources.flatMap((s) => s.items.filter((i) => cache.isSynced(scope, i.id)).map((i) => i.id)).sort();
}

describe("syncBackfillLanes (D262)", () => {
  test("8 lanes read several sources' pages at once and keep the same newest items, from the same calls", async () => {
    const run = async (config: Record<string, unknown>) => {
      ListSource.maxInFlight = 0;
      const sources = many(40, 12);
      const { partner, cache } = setup(sources, { syncMaxItems: 30, ...config });
      await warm(partner);
      return {
        held: held(cache, sources),
        calls: sources.reduce((n, s) => n + s.lists, 0),
        lanes: ListSource.maxInFlight,
      };
    };
    const one = await run({});
    const eight = await run({ syncBackfillLanes: 8 });
    // The trim's slack (it waits for the cap to pass by a page, and in-flight pages land past it) leaves the held
    // count between the cap and the cap plus a page or a lanes' batch; what is kept is still the newest items: the
    // 30 globally newest (src0–src29's newest page) are held by both, however the reads were scheduled.
    const newest = Array.from({ length: 30 }, (_, k) => itemId(`src${k}`, "i0"));
    for (const h of [one.held, eight.held]) {
      expect(h.length).toBeGreaterThanOrEqual(30);
      expect(h.length).toBeLessThanOrEqual(120);
      for (const id of newest) expect(h).toContain(id);
    }
    expect(eight.calls).toBe(one.calls);
    expect(one.lanes).toBe(1);
    expect(eight.lanes).toBeGreaterThan(1);
    expect(eight.lanes).toBeLessThanOrEqual(8);
  });
});

describe("syncLocalComplete (D264)", () => {
  test("a copy cut at syncMaxItems is not complete; one that holds its whole listing is", async () => {
    const sources = many(6, 10);
    const { partner, cache } = setup(sources, { syncMaxItems: 20 });
    await warm(partner);
    // 60 items for 20 places plus a page of slack: a source is complete exactly when the user holds all of its items.
    const whole0 = sources.map((s) => s.items.every((i) => cache.isSynced(scope, i.id)));
    expect(sources.map((s) => partner.sync!.complete(scope, s.id))).toEqual(whole0);
    expect(whole0.filter((x) => !x).length).toBeGreaterThanOrEqual(3);
    const whole = many(2, 3);
    const two = setup(whole, { syncMaxItems: 20 });
    await warm(two.partner);
    for (const s of whole) expect(two.partner.sync!.complete(scope, s.id)).toBe(true);
    expect(two.partner.sync!.complete(scope, "nope")).toBe(false);
  });

  test("an item older than the cut is found by a live search with it on, and missed with it off", async () => {
    const ask = async (config: Record<string, unknown>) => {
      const sources = many(6, 10);
      // The oldest item of source 0, far past the cut, is the one the user asks about.
      const old = sources[0]!.items.at(-1)!;
      old.title = "Zed Quinn contract";
      old.text = "Zed Quinn signed the contract renewal for Globex";
      const { partner } = setup(sources, {
        syncMaxItems: 20,
        syncStaleChance: 0.99,
        syncMaxStaleMs: 24 * HOUR,
        ...config,
      });
      await warm(partner);
      const res = await partner.ask({ ...scope, sessionId: "s1", question: "Did Zed Quinn sign the Globex renewal?" });
      return {
        cited: res.citations.map((c) => c.itemId).includes(old.id),
        searches: sources.reduce((n, s) => n + s.searches, 0),
      };
    };
    const off = await ask({});
    const on = await ask({ syncLocalComplete: true });
    expect(off.cited).toBe(false);
    expect(off.searches).toBe(0);
    expect(on.cited).toBe(true);
    expect(on.searches).toBeGreaterThan(0);
  });

  test("complete copies still answer locally with it on: no search call", async () => {
    const sources = many(2, 3);
    sources[0]!.items[0]!.text = "Zed Quinn signed the contract renewal for Globex";
    const { partner } = setup(sources, {
      syncMaxItems: 20,
      syncStaleChance: 0.99,
      syncMaxStaleMs: 24 * HOUR,
      syncLocalComplete: true,
    });
    await warm(partner);
    const res = await partner.ask({ ...scope, sessionId: "s1", question: "Did Zed Quinn sign the Globex renewal?" });
    expect(res.citations.map((c) => c.itemId)).toContain(sources[0]!.items[0]!.id);
    expect(sources.reduce((n, s) => n + s.searches, 0)).toBe(0);
  });
});

describe("syncPollWidth (D263)", () => {
  const stalePolls = async (config: Record<string, unknown>) => {
    const sources = many(20, 3);
    const { partner, advance, now } = setup(sources, { syncMaxItems: 100, syncMaxStaleMs: HOUR, ...config });
    await warm(partner);
    advance(2 * HOUR); // Every copy is past its longest stand-in: all 20 are stale.
    const before = sources.reduce((n, s) => n + s.lists, 0);
    await partner.ask({ ...scope, sessionId: "s1", question: "What did source 3 say about item 1?" });
    void now;
    return sources.reduce((n, s) => n + s.lists, 0) - before;
  };

  test("a lookup over more sources than the width polls that many, or the sources it searches if more", async () => {
    expect(await stalePolls({})).toBe(20);
    expect(await stalePolls({ syncPollWidth: 10 })).toBe(10);
    // An ask searches `askSources` (6): every source it searches is polled first.
    expect(await stalePolls({ syncPollWidth: 4 })).toBe(6);
  });

  test("at or under the width every stale source is polled, as with it off", async () => {
    expect(await stalePolls({ syncPollWidth: 20 })).toBe(20);
    expect(await stalePolls({ syncPollWidth: 50 })).toBe(20);
  });
});

describe("routeLocalHits (D265)", () => {
  test("a source whose synced items share the request's words is searched first among many", async () => {
    const run = async (config: Record<string, unknown>) => {
      const noise = many(200, 2);
      const words = ["isa allowance tax year", "pension contribution", "savings rate isa", "allowance letter"];
      // Three recent statements share the request's words (they are synced); older ones do not, and the oldest, the
      // one the user asks about, is far past the user's cut (never listed).
      const bank = new ListSource(
        "bank",
        Array.from({ length: 25 }, (_, i) => ({
          id: itemId("bank", `b${i}`),
          sourceId: "bank",
          ref: `b${i}`,
          title: `Statement ${i}`,
          text: i < 3 ? `Your ${words[i]} update number ${i}` : `Monthly statement ${i} for your current account`,
          updatedAt: T0 - (i < 3 ? i : 400 + i) * HOUR,
        })),
      );
      bank.items[24]!.text = "You have used your full ISA allowance for this tax year";
      const sources = [...noise, bank];
      const { partner } = setup(sources, {
        syncMaxItems: 300,
        syncStaleChance: 0.99,
        syncMaxStaleMs: 24 * HOUR,
        syncLocalComplete: true,
        // The routing order is what is tested: with the earn rule (D603) a new user's cut copy is not searched on
        // the request's common words at all.
        sourceYieldEarn: false,
        ...config,
      });
      await warm(partner);
      expect(partner.sync!.complete(scope, "bank")).toBe(false);
      const res = await partner.ask({
        ...scope,
        sessionId: "s1",
        question: "Have I used my ISA allowance this tax year?",
      });
      return { searched: bank.searches > 0, cited: res.citations.map((c) => c.itemId).includes(bank.items[24]!.id) };
    };
    // Off, 201 sources with flat priors: the ask's 6 and the probes' picks miss the bank (seeded, so it stays so).
    expect(await run({})).toEqual({ searched: false, cited: false });
    expect(await run({ routeLocalHits: true })).toEqual({ searched: true, cited: true });
  });

  test("routing adds the boost to a source's score and nothing else", () => {
    const map = new SourceMap(":memory:", { explore: false });
    const ids = ["a", "b", "c"];
    const plain = map.route({ scope, entities: [], situation: "chat", sourceIds: ids, limit: 3 });
    const boosted = map.route({
      scope,
      entities: [],
      situation: "chat",
      sourceIds: ids,
      limit: 3,
      boost: new Map([["c", 1]]),
    });
    expect(plain.map((r) => r.sourceId)).toEqual(["a", "b", "c"]);
    expect(boosted.map((r) => r.sourceId)).toEqual(["c", "a", "b"]);
    expect(boosted[0]!.score).toBeCloseTo(plain[2]!.score + 1);
  });
});

describe("review regressions (A1)", () => {
  test("an ask over more sources than the poll width never answers a stale copy it did not poll", async () => {
    // Review of D263: the poll's pre-route and the lookup's route drew apart, and an ask answered stale, unpolled
    // copies as "Nothing in the connected sources.".
    const run = async (config: Record<string, unknown>) => {
      const sources = many(20, 3);
      const { partner, advance, now } = setup(sources, { syncMaxItems: 100, syncMaxStaleMs: HOUR, ...config });
      await warm(partner);
      advance(2 * HOUR); // Every copy is stale.
      sources[0]!.items.push({
        id: itemId("src0", "fresh"),
        sourceId: "src0",
        ref: "fresh",
        title: "Zed Quinn contract",
        text: "Zed Quinn signed the Globex contract renewal today",
        updatedAt: now(),
      });
      const res = await partner.ask({ ...scope, sessionId: "s1", question: "Did Zed Quinn sign the Globex renewal?" });
      return {
        cited: res.citations.map((c) => c.itemId).includes(itemId("src0", "fresh")),
        // Every source the ask reports as answered from the index was current: polled, not a stale copy.
        staleLocal: (res.sources ?? []).filter(
          (x) => x.status === "local" && !partner.sync!.current(scope, x.sourceId),
        ),
      };
    };
    expect((await run({})).cited).toBe(true);
    for (const width of [2, 4, 8]) {
      const r = await run({ syncPollWidth: width });
      expect(r.staleLocal).toEqual([]);
    }
  });

  test("a copy whose items the cache let go is no longer complete", async () => {
    const sources = many(2, 4);
    const cache = new ItemCache({ maxSyncedPerUser: 6 });
    const { partner } = setup(sources, { syncMaxItems: 100 }, cache);
    await warm(partner);
    const whole = sources.map((s) => s.items.every((i) => cache.isSynced(scope, i.id)));
    expect(whole.some((x) => !x)).toBe(true);
    expect(sources.map((s) => partner.sync!.complete(scope, s.id))).toEqual(whole);
  });

  test("the held count tracks puts and drops: a kept copy stays whole, a dropped item cuts it for good", async () => {
    const sources = many(2, 3);
    const cache = new ItemCache();
    const { partner } = setup(sources, { syncMaxItems: 100 }, cache);
    await warm(partner);
    expect(partner.sync!.complete(scope, "src0")).toBe(true);
    // A lookup's put of a synced item (not synced-marked itself) leaves it synced: complete reads no change.
    const it = sources[0]!.items[0]!;
    cache.put(scope, [{ ...it, text: "changed words, still the source's item" }], T0 + 1, false, false, 0, 0);
    expect(cache.isSynced(scope, it.id)).toBe(true);
    expect(partner.sync!.complete(scope, "src0")).toBe(true);
    // A synced item dropped from the cache cuts the copy for good, like the rescan found it.
    cache.dropSynced(scope, [sources[0]!.items[1]!.id]);
    expect(partner.sync!.complete(scope, "src0")).toBe(false);
    // Deletions (`removeItems` holds the id gone) count as dropped too; the other source's copy is untouched.
    cache.removeItems(scope, [sources[1]!.items[0]!.id], T0 + 2);
    expect(partner.sync!.complete(scope, "src1")).toBe(false);
  });

  test("whether a copy is cut is each user's own", async () => {
    // u1 has 60 items for 20 places plus a page of slack (cut); u2 has two sources of 3 items under the same ids
    // (6 items: all fit).
    const u1Sources = many(6, 10);
    const u2Sources = many(2, 3);
    const other = { tenantId: "t1", userId: "u2" };
    const cache = new ItemCache();
    const partner = new ContextPartner({
      sources: async (sc) => (sc.userId === "u2" ? u2Sources : u1Sources),
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache,
      budget: new Budget(),
      model: null,
      now: () => T0,
      config: { sync: true, syncPageSize: 10, syncPollPageSize: 2, syncCallsPerMin: 6_000, ...OFF, syncMaxItems: 20 },
    });
    for (const sc of [scope, other]) {
      partner.sync!.track(sc);
      for (let i = 0; i < 200 && !partner.sync!.warm(sc); i++) await partner.sync!.tick();
    }
    // Same source ids, different copies: u1's are cut, u2's whole.
    expect(["src0", "src1"].some((id) => !partner.sync!.complete(scope, id))).toBe(true);
    expect(["src0", "src1"].map((id) => partner.sync!.complete(other, id))).toEqual([true, true]);
    partner.forget(scope);
    expect(u1Sources.map((s) => partner.sync!.complete(scope, s.id)).every((x) => !x)).toBe(true);
    expect(["src0", "src1"].map((id) => partner.sync!.complete(other, id))).toEqual([true, true]);
    expect(cache.syncedCount(other)).toBe(6);
  });
});
