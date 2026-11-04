import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import type { Trace } from "./trace";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 9);

/** A connector with a recent-first list call; every call is counted, and its items can change between calls. */
class ListSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  searches = 0;
  lists = 0;
  /** The `limit` of every list call, in order. */
  limits: number[] = [];
  failLists = false;
  /** While set, every list call waits for it (a read held open, to overlap another with it). */
  gate: Promise<void> | null = null;
  items: ContextItem[];
  constructor(
    readonly id: string,
    docs: { ref: string; title: string; text: string; at: number }[],
  ) {
    this.items = docs.map((d) => this.make(d.ref, d.title, d.text, d.at));
  }
  make(ref: string, title: string, text: string, at: number): ContextItem {
    return { id: itemId(this.id, ref), sourceId: this.id, ref, title, text, updatedAt: at };
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    this.searches++;
    const words = q.text.toLowerCase().split(/\W+/).filter(Boolean);
    return this.items.filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)));
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    this.lists++;
    this.limits.push(limit);
    if (this.gate) await this.gate;
    if (this.failLists) throw new Error("500 Internal Server Error");
    const sorted = [...this.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
}

function setup(sources: Source[], config: Record<string, unknown> = {}, cache = new ItemCache()) {
  let clock = T0;
  const traces: Trace[] = [];
  const partner = new ContextPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache,
    budget: new Budget(),
    model: null,
    now: () => clock,
    config: { sync: true, syncPageSize: 2, syncCallsPerMin: 600, ...config },
    onTrace: (t) => traces.push(t),
  });
  return {
    partner,
    cache,
    traces,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
  };
}

const scope = { tenantId: "t1", userId: "u1" };
const say = (p: ContextPartner, text: string, s: Scope = scope, sessionId = "s1", at = T0) =>
  p.observe({ ...s, sessionId, at, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });

function mail(n: number, base = T0) {
  return Array.from({ length: n }, (_, i) => ({
    ref: `m${i}`,
    title: `Mail ${i}`,
    text: `Note number ${i} about the quarterly plan`,
    at: base - i * HOUR,
  }));
}

describe("background sync (D57)", () => {
  test("off (the default minus sync): no sync, no list call, the lookup searches live", async () => {
    const src = new ListSource("mail", mail(3));
    const p = new ContextPartner({
      sources: async () => [src],
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      config: { sync: false },
    });
    expect(p.sync).toBeNull();
    await say(p, "What about the quarterly plan from Dana Lee?");
    expect(src.lists).toBe(0);
    expect(src.searches).toBeGreaterThan(0);
  });

  test("the backfill reads the newest items across sources, merged by recency, up to syncMaxItems", async () => {
    // Mail is busy (an item an hour), the CRM quiet (a day apart): the newest five overall are four mails and one
    // CRM record, not two pages of mail first.
    const mailSrc = new ListSource("mail", mail(10));
    const crm = new ListSource(
      "crm",
      Array.from({ length: 4 }, (_, i) => ({
        ref: `c${i}`,
        title: `Acct ${i}`,
        text: "account",
        at: T0 - i * 24 * HOUR,
      })),
    );
    const { partner, cache } = setup([mailSrc, crm], { syncMaxItems: 5 });
    partner.sync!.track(scope);
    for (let i = 0; i < 10 && !partner.sync!.warm(scope); i++) await partner.sync!.tick();
    expect(partner.sync!.warm(scope)).toBe(true);
    expect(cache.syncedCount(scope)).toBe(5);
    const held = ["m0", "m1", "m2", "m3"].map((r) => cache.isSynced(scope, itemId("mail", r)));
    expect(held).toEqual([true, true, true, true]);
    expect(cache.isSynced(scope, itemId("crm", "c0"))).toBe(true);
    expect(cache.isSynced(scope, itemId("mail", "m5"))).toBe(false);
    expect(cache.isSynced(scope, itemId("crm", "c1"))).toBe(false);
  });

  test("a warm, current source answers the lookup locally: no search call, and the fact is delivered", async () => {
    const src = new ListSource("mail", [
      { ref: "a", title: "Dana Lee: budget", text: "Dana Lee says the budget review moved to Friday", at: T0 - HOUR },
      ...mail(4, T0 - 2 * HOUR),
    ]);
    const { partner, traces } = setup([src], { syncStaleChance: 0.99, syncMaxStaleMs: 24 * HOUR });
    partner.sync!.track(scope);
    while (!partner.sync!.warm(scope)) await partner.sync!.tick();
    const lists = src.lists;
    const r = await say(partner, "Dana Lee budget review: when is it?");
    const got = [r.injection, ...partner.takePending({ ...scope, sessionId: "s1" })].flatMap(
      (x) => x?.citations.map((c) => c.itemId) ?? [],
    );
    expect(src.searches).toBe(0);
    expect(src.lists).toBe(lists);
    expect(got).toContain(itemId("mail", "a"));
    // The fast path delivered it from the synced copy: no trace of this turn made a source call.
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.map((t) => t.sourceCalls)).toEqual(traces.map(() => 0));
    // An ask always runs a lookup: it is answered from the local index (a source counted as local) at no call.
    const asked = await partner.ask({ ...scope, sessionId: "s1", question: "When is the Dana Lee budget review?" });
    expect(asked.citations.map((c) => c.itemId)).toContain(itemId("mail", "a"));
    const lookup = traces.find((t) => t.event === "ask");
    expect(lookup?.localSources).toBe(1);
    expect(lookup?.sourceCalls).toBe(0);
    expect(src.searches).toBe(0);
    expect(src.lists).toBe(lists);
  });

  test("a stale source is polled on demand (one listing call), and a new item it brings is answered locally", async () => {
    const src = new ListSource("mail", mail(4));
    const { partner, advance, now } = setup([src], { syncMaxStaleMs: 4 * HOUR });
    partner.sync!.track(scope);
    while (!partner.sync!.warm(scope)) await partner.sync!.tick();
    advance(5 * HOUR); // Past the longest a synced copy stands in.
    src.items.push(src.make("new", "Zed Quinn: contract", "Zed Quinn signed the contract renewal today", now()));
    expect(partner.sync!.current(scope, "mail")).toBe(false);
    const lists = src.lists;
    const r = await say(partner, "Did Zed Quinn sign the contract renewal?", scope, "s1", now());
    const got = [r.injection, ...partner.takePending({ ...scope, sessionId: "s1" })].flatMap(
      (x) => x?.citations.map((c) => c.itemId) ?? [],
    );
    expect(src.lists - lists).toBe(1);
    expect(src.searches).toBe(0);
    expect(got).toContain(itemId("mail", "new"));
    expect(partner.sync!.current(scope, "mail")).toBe(true);
  });

  describe("syncPollPageSize: polls sized to what changed", () => {
    // 40 mails an hour apart, one backfill page: the learned rate is about one change in four hours.
    const stale = async (config: Record<string, unknown>) => {
      const src = new ListSource("mail", mail(40));
      const env = setup([src], { syncPageSize: 100, syncMaxStaleMs: 4 * HOUR, ...config });
      env.partner.sync!.track(scope);
      while (!env.partner.sync!.warm(scope)) await env.partner.sync!.tick();
      env.advance(5 * HOUR);
      return { src, ...env };
    };
    const added = (src: ListSource, n: number, at: number) => {
      for (let i = 0; i < n; i++) {
        src.items.push(src.make(`new${i}`, `Zed Quinn ${i}`, `Zed Quinn contract renewal note ${i}`, at - i * 60_000));
      }
    };

    test("three changed items: one list call of at most five items, and the new item is delivered", async () => {
      const { src, partner, now } = await stale({ syncPollPageSize: 5 });
      added(src, 3, now());
      const before = src.limits.length;
      const r = await say(partner, "Did Zed Quinn sign the contract renewal?", scope, "s1", now());
      const calls = src.limits.slice(before);
      expect(calls).toEqual([5]);
      expect(partner.sync!.stats.demandItems).toBe(5);
      expect(partner.sync!.current(scope, "mail")).toBe(true);
      const got = [r.injection, ...partner.takePending({ ...scope, sessionId: "s1" })].flatMap(
        (x) => x?.citations.map((c) => c.itemId) ?? [],
      );
      expect(got.some((id) => id.startsWith("mail:new"))).toBe(true);
    });

    test("thirty changed items: two calls (5, then 95), and the lookup holds all thirty before it answers", async () => {
      const { src, partner, cache, now } = await stale({ syncPollPageSize: 5 });
      added(src, 30, now());
      const before = src.limits.length;
      await say(partner, "Did Zed Quinn sign the contract renewal?", scope, "s1", now());
      // The second page tops the first up to one full page: the same 100 items one full page lists, in two calls.
      expect(src.limits.slice(before)).toEqual([5, 95]);
      // The source holds 70 items (40 + 30): the 5 and the other 65.
      expect(partner.sync!.stats.demandItems).toBe(70);
      for (let i = 0; i < 30; i++) expect(cache.isSynced(scope, itemId("mail", `new${i}`))).toBe(true);
      expect(partner.sync!.current(scope, "mail")).toBe(true);
    });

    test("more changes than a page: at most one call more than full pages, and as many items caught up", async () => {
      const run = async (syncPollPageSize: number) => {
        const { src, partner, cache, now } = await stale({ syncPollPageSize, syncCatchupPages: 2 });
        added(src, 250, now());
        const before = src.limits.length;
        const stats = partner.sync!.stats;
        const calls0 = stats.demandCalls;
        await say(partner, "Did Zed Quinn sign the contract renewal?", scope, "s1", now());
        let held = 0;
        for (let i = 0; i < 250; i++) if (cache.isSynced(scope, itemId("mail", `new${i}`))) held++;
        return { limits: src.limits.slice(before, before + 3), calls: stats.demandCalls - calls0, held };
      };
      // Full pages: two calls of 100, 200 of the 250 changes held when the lookup answers (the rest in the background).
      const full = await run(0);
      expect(full.calls).toBe(2);
      expect(full.limits.slice(0, 2)).toEqual([100, 100]);
      // Adaptive: 5, 95, 100 - the same 200 items in three calls, never the 5, 10, 20, 40, ... of doubling pages.
      const adaptive = await run(5);
      expect(adaptive.calls).toBe(3);
      expect(adaptive.limits).toEqual([5, 95, 100]);
      expect(adaptive.held).toBeGreaterThanOrEqual(full.held);
      expect(adaptive.held).toBeGreaterThanOrEqual(200);
    });

    test("off (0): a poll reads full pages; the backfill's page size is unchanged either way", async () => {
      for (const pollPageSize of [0, 5]) {
        const src = new ListSource("mail", mail(25));
        const { partner, advance, now } = setup([src], {
          syncPageSize: 10,
          syncPollPageSize: pollPageSize,
          syncMaxStaleMs: 4 * HOUR,
        });
        partner.sync!.track(scope);
        while (!partner.sync!.warm(scope)) await partner.sync!.tick();
        expect(src.limits).toEqual([10, 10, 10]);
        advance(5 * HOUR);
        await say(partner, "Where is the quarterly plan?", scope, "s1", now());
        expect(src.limits.slice(3)).toEqual([pollPageSize === 0 ? 10 : 5]);
      }
    });
  });

  test("with on-demand polls off, a stale source is searched live as before", async () => {
    const src = new ListSource("mail", mail(4));
    const { partner, advance, now } = setup([src], { syncOnDemand: false, syncMaxStaleMs: 4 * HOUR });
    partner.sync!.track(scope);
    while (!partner.sync!.warm(scope)) await partner.sync!.tick();
    advance(5 * HOUR);
    await say(partner, "Where is the quarterly plan?", scope, "s1", now());
    expect(src.searches).toBeGreaterThan(0);
  });

  test("two sweeps in a row that miss an item drop it (delete propagation)", async () => {
    const src = new ListSource("mail", mail(5));
    const { partner, cache, advance, now } = setup([src], { syncSweepMs: HOUR });
    partner.sync!.track(scope);
    while (!partner.sync!.warm(scope)) await partner.sync!.tick();
    expect(cache.get(scope, itemId("mail", "m3"), now())).not.toBeNull();
    src.items = src.items.filter((i) => i.ref !== "m3");
    advance(2 * HOUR);
    partner.sync!.track(scope); // Still active: sweeps run for active users only.
    for (let i = 0; i < 5; i++) await partner.sync!.tick();
    // One sweep's miss may be an offset listing shifting between pages: kept until the next sweep misses it too.
    expect(cache.get(scope, itemId("mail", "m3"), now())).not.toBeNull();
    expect(partner.sync!.stats.deleted).toBe(0);
    advance(2 * HOUR);
    partner.sync!.track(scope);
    for (let i = 0; i < 5; i++) await partner.sync!.tick();
    expect(cache.get(scope, itemId("mail", "m3"), now())).toBeNull();
    expect(cache.isSynced(scope, itemId("mail", "m2"))).toBe(true);
    expect(partner.sync!.stats.deleted).toBe(1);
  });

  test("a failing listing drops nothing and backs off", async () => {
    const src = new ListSource("mail", mail(5));
    const { partner, cache, advance } = setup([src], { syncSweepMs: HOUR });
    partner.sync!.track(scope);
    while (!partner.sync!.warm(scope)) await partner.sync!.tick();
    src.failLists = true;
    advance(2 * HOUR);
    partner.sync!.track(scope);
    await partner.sync!.tick();
    const calls = src.lists;
    await partner.sync!.tick(); // Within the back-off: no call.
    expect(src.lists).toBe(calls);
    expect(cache.syncedCount(scope)).toBe(5);
  });

  test("isolation: each user's sync is their own; forget drops one user's synced items and state only", async () => {
    const a = new ListSource("mail", [{ ref: "x", title: "Secret plan", text: "Alpha's secret plan", at: T0 }]);
    const b = new ListSource("mail", [{ ref: "y", title: "Other plan", text: "Beta's other plan", at: T0 }]);
    const cache = new ItemCache();
    let clock = T0;
    const partner = new ContextPartner({
      sources: async (s) => (s.userId === "a" ? [a] : [b]),
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache,
      budget: new Budget(),
      model: null,
      now: () => clock,
      config: { sync: true },
    });
    const ua = { tenantId: "t", userId: "a" };
    const ub = { tenantId: "t", userId: "b" };
    partner.sync!.track(ua);
    partner.sync!.track(ub);
    for (let i = 0; i < 3; i++) await partner.sync!.tick();
    expect(cache.isSynced(ua, itemId("mail", "x"))).toBe(true);
    expect(cache.get(ua, itemId("mail", "y"), clock)).toBeNull();
    expect(cache.get(ub, itemId("mail", "x"), clock)).toBeNull();
    expect(cache.get(ub, itemId("mail", "y"), clock)).not.toBeNull();
    partner.forget(ua);
    expect(cache.syncedCount(ua)).toBe(0);
    expect(partner.sync!.warm(ua)).toBe(false);
    expect(cache.isSynced(ub, itemId("mail", "y"))).toBe(true);
    clock += HOUR;
    await partner.sync!.tick(); // A forgotten user is not synced again until they come back.
    expect(cache.syncedCount(ua)).toBe(0);
  });

  test("a page that lands after the user was forgotten (and came back) is not stored", async () => {
    const src = new ListSource("mail", mail(3));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const list = src.list.bind(src);
    src.list = async (...args) => {
      await gate;
      return list(...args);
    };
    const { partner, cache } = setup([src]);
    partner.sync!.track(scope);
    const ticking = partner.sync!.tick();
    await new Promise((r) => setTimeout(r, 5));
    partner.forget(scope);
    partner.sync!.track(scope); // Back at once: a new sync for them, which the old page must not feed.
    release();
    await ticking;
    expect(cache.syncedCount(scope)).toBe(0);
  });

  test("retention: a user idle past syncDropMs stops being synced and their synced items go", async () => {
    const src = new ListSource("mail", mail(3));
    const { partner, cache, advance } = setup([src], { syncDropMs: 2 * HOUR });
    partner.sync!.track(scope);
    while (!partner.sync!.warm(scope)) await partner.sync!.tick();
    expect(cache.syncedCount(scope)).toBe(3);
    advance(3 * HOUR);
    await partner.sync!.tick();
    expect(cache.syncedCount(scope)).toBe(0);
    expect(partner.sync!.userCount).toBe(0);
  });

  test("users per tenant are capped: the least recently active stops being synced, another tenant is untouched", async () => {
    const src = new ListSource("mail", mail(2));
    const { partner, advance } = setup([src], { syncMaxUsersPerTenant: 2 });
    partner.sync!.track({ tenantId: "other", userId: "o" });
    for (const u of ["u1", "u2", "u3"]) {
      partner.sync!.track({ tenantId: "t1", userId: u });
      advance(1_000);
    }
    await partner.sync!.tick();
    expect(partner.sync!.userCount).toBe(3);
    expect(partner.sync!.warm({ tenantId: "t1", userId: "u1" })).toBe(false);
    expect(partner.sync!.warm({ tenantId: "other", userId: "o" })).toBe(true);
  });

  test("synced text is redacted before it is held", async () => {
    const key = "AKIAIOSFODNN7EXAMPLE";
    const src = new ListSource("mail", [{ ref: "k", title: "keys", text: `aws key ${key} for the deploy`, at: T0 }]);
    const { partner, cache, now } = setup([src]);
    partner.sync!.track(scope);
    while (!partner.sync!.warm(scope)) await partner.sync!.tick();
    const held = cache.get(scope, itemId("mail", "k"), now());
    expect(held).not.toBeNull();
    expect(held!.text).not.toContain(key);
  });

  test("a source without a list call is not synced and is searched live", async () => {
    const plain: Source = {
      id: "docs",
      kind: "test",
      description: "",
      search: async () => [],
    };
    const { partner } = setup([plain]);
    partner.sync!.track(scope);
    await partner.sync!.tick();
    expect(partner.sync!.warm(scope)).toBe(false);
    expect(partner.sync!.current(scope, "docs")).toBe(false);
  });
});

describe("item cache: synced items (D57)", () => {
  const it = (id: string, text = id): ContextItem => ({ id: `s:${id}`, sourceId: "s", ref: id, title: "", text });

  test("synced and looked-up items have separate caps: neither evicts the other", () => {
    const cache = new ItemCache({ maxItemsPerUser: 2, maxSyncedPerUser: 3 });
    cache.put(scope, [it("a"), it("b"), it("c")], T0, false, true);
    cache.put(scope, [it("x"), it("y"), it("z")], T0 + 1);
    expect(["a", "b", "c"].map((x) => cache.isSynced(scope, `s:${x}`))).toEqual([true, true, true]);
    expect(cache.get(scope, "s:x", T0 + 1)).toBeNull();
    expect(cache.get(scope, "s:z", T0 + 1)).not.toBeNull();
    cache.put(scope, [it("d")], T0 + 2, false, true);
    expect(cache.get(scope, "s:a", T0 + 2)).toBeNull();
    expect(cache.syncedCount(scope)).toBe(3);
  });

  test("a synced item outlives the lookup TTL, up to syncTtlMs; a lookup's copy keeps it synced", () => {
    const cache = new ItemCache({ ttlMs: HOUR, syncTtlMs: 10 * HOUR });
    cache.put(scope, [it("a")], T0, false, true);
    cache.put(scope, [it("a")], T0); // the same item, returned by a lookup
    cache.put(scope, [it("b")], T0);
    expect(cache.isSynced(scope, "s:a")).toBe(true);
    expect(cache.get(scope, "s:a", T0 + 5 * HOUR)).not.toBeNull();
    expect(cache.get(scope, "s:b", T0 + 5 * HOUR)).toBeNull();
    expect(cache.get(scope, "s:a", T0 + 11 * HOUR)).toBeNull();
  });

  test("searchIn answers per source, every word or ranked", () => {
    const cache = new ItemCache();
    const m = (src: string, id: string, text: string): ContextItem => ({
      id: `${src}:${id}`,
      sourceId: src,
      ref: id,
      title: "",
      text,
    });
    cache.put(scope, [m("mail", "1", "dana lee budget"), m("mail", "2", "dana budget"), m("chat", "3", "dana lee")]);
    const vocab = cache.vocabOf(scope);
    const ids = ["dana", "lee"].map((w) => vocab.lookup(w));
    const all = cache.searchIn(scope, ids, 2, 5, new Set(["mail"]), true).map((h) => h.item.id);
    expect(all).toEqual(["mail:1"]);
    const any = cache.searchIn(scope, ids, 2, 5, new Set(["mail", "chat"]), false).map((h) => h.item.id);
    expect(new Set(any)).toEqual(new Set(["mail:1", "mail:2", "chat:3"]));
  });
});

// Audit 2026-11-03b (corr-shared-poll-counts-as-fresh): a lookup whose on-demand poll finds the source already being
// read waits for that read and counts what it stored, not one, so a static world's waiter triggers no follow-up.
describe("freshen: a waiter counts what the read it waited on stored", () => {
  const held = () => {
    let free = () => {};
    const gate = new Promise<void>((r) => (free = r));
    return { gate, free: () => free() };
  };
  async function stale(config: Record<string, unknown> = {}) {
    const src = new ListSource("mail", mail(4));
    const t = setup([src], { syncMaxStaleMs: 4 * HOUR, syncActiveMs: 48 * HOUR, ...config });
    const sync = t.partner.sync!;
    sync.track(scope);
    while (!sync.warm(scope)) await sync.tick();
    t.advance(5 * HOUR); // Past syncMaxStaleMs: a lookup polls.
    return { src, sync, ...t };
  }
  const signal = () => new AbortController().signal;

  test("static world: the poller and the waiter both count 0, and only the poller counts the call", async () => {
    const { src, sync } = await stale();
    const h = held();
    src.gate = h.gate;
    const lists = src.lists;
    const first = { fresh: 0 };
    const second = { fresh: 0 };
    const a = sync.freshen(scope, [src], signal(), first);
    const b = sync.freshen(scope, [src], signal(), second);
    src.gate = null;
    h.free();
    const calls = [await a, await b];
    expect(src.lists - lists).toBe(1);
    expect(first.fresh).toBe(0);
    expect(second.fresh).toBe(0);
    // Each freshen returns its own calls: the call was the poller's, so the two sum to what the connector received.
    expect(calls).toEqual([1, 0]);
  });

  test("one stored item: the waiter counts it as the poller does", async () => {
    const { src, sync, now } = await stale();
    src.items.push(src.make("new", "Mail new", "A new note about the quarterly plan", now()));
    const h = held();
    src.gate = h.gate;
    const first = { fresh: 0 };
    const second = { fresh: 0 };
    const a = sync.freshen(scope, [src], signal(), first);
    const b = sync.freshen(scope, [src], signal(), second);
    src.gate = null;
    h.free();
    await Promise.all([a, b]);
    expect(first.fresh).toBe(1);
    expect(second.fresh).toBe(1);
  });

  test("a background sweep that stores an item: the lookup waiting on it counts it", async () => {
    const { src, sync, now } = await stale({ syncSweepMs: HOUR });
    src.items.push(src.make("new", "Mail new", "A new note about the quarterly plan", now()));
    const h = held();
    src.gate = h.gate;
    const lists = src.lists;
    const ticking = sync.tick(); // The sweep is due: it holds the source.
    for (let n = 0; src.lists === lists; n++) {
      if (n > 1_000) throw new Error("the sweep never started");
      await Bun.sleep(0);
    }
    const tally = { fresh: 0 };
    const waited = sync.freshen(scope, [src], signal(), tally);
    src.gate = null;
    h.free();
    await ticking;
    expect(await waited).toBe(0); // The sweep's calls are background calls, not this lookup's.
    expect(tally.fresh).toBe(1);
  });

  test("a waiter whose lookup gives up counts 0, whatever the read then stores", async () => {
    const { src, sync, now } = await stale();
    src.items.push(src.make("new", "Mail new", "A new note about the quarterly plan", now()));
    const h = held();
    src.gate = h.gate;
    const a = sync.freshen(scope, [src], signal(), { fresh: 0 });
    const stop = new AbortController();
    const tally = { fresh: 0 };
    const b = sync.freshen(scope, [src], stop.signal, tally);
    stop.abort();
    await b;
    src.gate = null;
    h.free();
    await a;
    expect(tally.fresh).toBe(0);
  });
});

describe("syncPush: a source that notifies is polled when told it changed", () => {
  /** A connector whose integrator forwards its change notifications. */
  class NotifyingSource extends ListSource {
    readonly notifies = true;
  }
  const warm = async (src: ListSource, config: Record<string, unknown> = {}) => {
    // One backfill page: the clock stands still here, so the sync's rate limit would never refill for more.
    const env = setup([src], { syncPush: true, syncMaxStaleMs: 6 * HOUR, syncPageSize: 100, ...config });
    env.partner.sync!.track(scope);
    while (!env.partner.sync!.warm(scope)) await env.partner.sync!.tick();
    return env;
  };

  test("no notification: current between lookups, however busy its learned rate says it is", async () => {
    const src = new NotifyingSource("mail", mail(20));
    const { partner, advance } = await warm(src);
    advance(3 * HOUR); // 20 mails an hour apart would make it stale by its rate alone.
    expect(partner.sync!.current(scope, "mail")).toBe(true);
    // The same copy without push goes by its rate.
    const plain = new ListSource("mail", mail(20));
    const other = await warm(plain, { syncPush: false });
    other.advance(3 * HOUR);
    expect(other.partner.sync!.current(scope, "mail")).toBe(false);
  });

  test("a notification makes it stale; the next lookup polls once, and a burst of notifications costs one poll", async () => {
    const src = new NotifyingSource("mail", mail(4));
    const { partner, advance, now } = await warm(src);
    advance(HOUR);
    src.items.push(src.make("new", "Zed Quinn: contract", "Zed Quinn signed the contract renewal today", now()));
    for (let i = 0; i < 5; i++) expect(partner.sourceChanged(scope, "mail")).toBe(true);
    expect(partner.sync!.current(scope, "mail")).toBe(false);
    const lists = src.lists;
    const r = await say(partner, "Did Zed Quinn sign the contract renewal?", scope, "s1", now());
    expect(src.lists - lists).toBe(1);
    const got = [r.injection, ...partner.takePending({ ...scope, sessionId: "s1" })].flatMap(
      (x) => x?.citations.map((c) => c.itemId) ?? [],
    );
    expect(got).toContain(itemId("mail", "new"));
    expect(partner.sync!.current(scope, "mail")).toBe(true);
    // Another lookup with no notification since: no call.
    await say(partner, "Did Zed Quinn sign the contract renewal?", scope, "s2", now());
    expect(src.lists - lists).toBe(1);
  });

  test("with span tracing on, push still decides polls (no poll without a notification)", async () => {
    const src = new NotifyingSource("mail", mail(20));
    const { partner, advance, now } = await warm(src, { spans: true });
    advance(3 * HOUR);
    const lists = src.lists;
    await say(partner, "Did Zed Quinn sign the contract renewal?", scope, "s1", now());
    expect(src.lists).toBe(lists);
    expect(partner.sync!.current(scope, "mail")).toBe(true);
  });

  test("past syncPushMaxStaleMs a notifying source is polled anyway (a lost notification is bounded)", async () => {
    const src = new NotifyingSource("mail", mail(4));
    const { partner, advance } = await warm(src, { syncPushMaxStaleMs: 24 * HOUR });
    advance(7 * HOUR); // Past syncMaxStaleMs, which bounds sources that do not notify: still current.
    expect(partner.sync!.current(scope, "mail")).toBe(true);
    advance(18 * HOUR);
    expect(partner.sync!.current(scope, "mail")).toBe(false);
  });

  test("items a notification carried are redacted and held as synced, with no source call; per user", async () => {
    const src = new NotifyingSource("mail", mail(4));
    const { partner, cache, now } = await warm(src);
    const lists = src.lists;
    const key = "sk-ant-api03-" + "b".repeat(40);
    const item = {
      id: itemId("mail", "pushed"),
      sourceId: "mail",
      ref: "pushed",
      title: "Zed Quinn: contract",
      text: `Zed Quinn signed the renewal. Token ${key}`,
      updatedAt: now(),
    };
    expect(await partner.sourceItems(scope, "mail", [item, { ...item, id: "other:x", sourceId: "other" }])).toBe(1);
    expect(src.lists).toBe(lists);
    const held = cache.get(scope, itemId("mail", "pushed"), now());
    expect(held?.text).toContain("Zed Quinn signed the renewal");
    expect(held?.text).not.toContain(key);
    expect(cache.get(scope, "other:x", now())).toBeFalsy();
    expect(cache.get({ tenantId: "t1", userId: "u2" }, itemId("mail", "pushed"), now())).toBeFalsy();
    expect(partner.sync!.current(scope, "mail")).toBe(true);
  });

  test("off (the default): notifications do nothing; a source that does not notify goes by its rate", async () => {
    const src = new NotifyingSource("mail", mail(4));
    const { partner } = await warm(src, { syncPush: false });
    expect(partner.sourceChanged(scope, "mail")).toBe(false);
    expect(await partner.sourceItems(scope, "mail", [src.make("x", "X", "x", T0)])).toBe(0);
    const plain = new ListSource("mail", mail(4));
    const on = await warm(plain);
    expect(on.partner.sourceChanged(scope, "nope")).toBe(false);
  });
});
