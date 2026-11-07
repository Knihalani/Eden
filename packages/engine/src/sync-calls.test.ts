/**
 * Audit A5, connector calls (priced per call): the sync's listings counted against what a lookup, a back-off and the
 * daily sweep should cost (docs/research/a5-bugs.md, "Wasted connector calls", D283). Each test failed before its fix;
 * the "Before the fix" comments record what the code did then.
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import type { Trace } from "./trace";
import { CORE_CONFIG } from "./parts";
import { ContextPartner } from "./partner";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 9);
const scope = { tenantId: "t1", userId: "u1" };

class Counted implements Source {
  readonly kind = "test";
  readonly description = "test";
  searches = 0;
  lists = 0;
  failLists = false;
  items: ContextItem[];
  constructor(
    readonly id: string,
    n: number,
  ) {
    this.items = Array.from({ length: n }, (_, i) => ({
      id: itemId(id, `m${i}`),
      sourceId: id,
      ref: `m${i}`,
      title: `Mail ${i}`,
      text: `Note ${i} about the quarterly plan`,
      updatedAt: T0 - i * HOUR,
    }));
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    this.searches++;
    const w = q.text.toLowerCase().split(/\W+/).filter(Boolean);
    return this.items.filter((i) => w.some((x) => i.text.toLowerCase().includes(x)));
  }
  async list(_s: Scope, cursor: string | undefined, limit: number, _signal?: AbortSignal): Promise<ListPage> {
    this.lists++;
    if (this.failLists) throw new Error("500 Internal Server Error");
    const at = cursor ? Number(cursor) : 0;
    return {
      items: this.items.slice(at, at + limit),
      next: at + limit < this.items.length ? String(at + limit) : null,
    };
  }
}

describe("audit A5, connector calls: sync", () => {
  test("a listing that failed is not listed again by every lookup within its back-off", async () => {
    const src = new Counted("mail", 4);
    let clock = T0;
    const partner = new ContextPartner({
      sources: async () => [src],
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => clock,
      config: { ...CORE_CONFIG, sync: true, syncOnDemand: true, syncPageSize: 10, syncCallsPerMin: 600 },
    });
    partner.sync!.track(scope);
    while (!partner.sync!.warm(scope)) await partner.sync!.tick();
    src.failLists = true;
    clock += 7 * HOUR; // past syncMaxStaleMs: stale
    const ask = (i: number) => partner.ask({ ...scope, sessionId: `s${i}`, question: `quarterly plan note ${i}?` });
    await ask(0); // the first poll fails: the source backs off 30 s (sync.ts failed())
    const listsAfterFirst = src.lists;
    for (let i = 1; i <= 5; i++) {
      clock += 1_000; // well inside the 30 s back-off
      const r = await ask(i);
      void r;
    }
    // One more listing (a listing that failed once is usually back, and a poll is cheaper than the live search it
    // replaces), then none inside the back-off: each ask searches live, as it does anyway. Was one listing per ask.
    expect(src.lists - listsAfterFirst).toBe(1);
  });

  test("a broken list tool costs every ask (31 s apart) a failing listing besides its search, past the back-off's doubling", async () => {
    const src = new Counted("mail", 4);
    let clock = T0;
    const partner = new ContextPartner({
      sources: async () => [src],
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => clock,
      config: { ...CORE_CONFIG, sync: true, syncOnDemand: true, syncPageSize: 10, syncCallsPerMin: 600 },
    });
    partner.sync!.track(scope);
    while (!partner.sync!.warm(scope)) await partner.sync!.tick();
    src.failLists = true;
    clock += 7 * HOUR;
    const statuses: string[] = [];
    for (let i = 0; i < 12; i++) {
      clock += 31_000; // past the breaker's openMs each time: half-open
      const r = await partner.ask({ ...scope, sessionId: `s${i}`, question: `quarterly plan note ${i} topic${i}?` });
      statuses.push(r.sources?.[0]?.status ?? "none");
    }
    // Expected (the back-off doubles 30 s, 60 s, 2 min, ... 30 min): 4 listings over these 6 minutes (at 31, 62, 124,
    // 248 s). Before the fix: 12 failing listings, one per ask, each beside the search the ask makes anyway (breaker
    // never opens at this spacing: too few calls per window).
    expect({ lists: src.lists - 1, searches: src.searches, open: statuses.filter((x) => x === "open").length }).toEqual(
      {
        lists: 4,
        searches: 12,
        open: 0,
      },
    );
  });

  test("a sweep lists a source past the oldest item the backfill kept from it, up to the user's whole cap", async () => {
    // Mail is busy (an item an hour), docs quiet (a day apart). The backfill keeps the user's newest 20 across both:
    // most from mail, a few docs. The daily sweep only needs to re-list what was kept (to see what is gone), but it
    // pages each source until it has seen `syncMaxItems` items, whatever that source holds synced.
    const mail = new Counted("mail", 60);
    const docs = new Counted("docs", 60);
    docs.items = docs.items.map((it, i) => ({ ...it, updatedAt: T0 - i * 24 * HOUR }));
    let clock = T0;
    const cache = new ItemCache();
    const partner = new ContextPartner({
      sources: async () => [mail, docs],
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache,
      budget: new Budget(),
      model: null,
      now: () => clock,
      config: {
        ...CORE_CONFIG,
        sync: true,
        syncOnDemand: true,
        syncPageSize: 5,
        syncMaxItems: 20,
        syncCallsPerMin: 6000,
        syncSweepMs: 24 * HOUR,
      },
    });
    partner.sync!.track(scope);
    while (!partner.sync!.warm(scope)) await partner.sync!.tick();
    const docsKept = docs.items.filter((it) => cache.isSynced(scope, it.id)).length;
    const before = docs.lists;
    clock += 25 * HOUR;
    partner.sync!.track(scope);
    for (let i = 0; i < 5; i++) await partner.sync!.tick();
    const docsSweep = docs.lists - before;
    const docsSyncedAfter = docs.items.filter((it) => cache.isSynced(scope, it.id)).length;
    // Expected: the sweep pages docs only past the oldest item kept from it (ceil(kept / 5) + 1 pages at most), and
    // syncs nothing the backfill's cut left out. Before the fix: 4 pages (20 items) and the synced docs grow to 20.
    expect(docsSweep).toBeLessThanOrEqual(Math.ceil(docsKept / 5) + 1);
    expect(docsSyncedAfter).toBe(docsKept);
  });

  test("a listing slower than the lookup's deadline is cut off by every lookup and never brings the source current", async () => {
    const traces: Trace[] = [];
    // `sourceTimeoutMs` 100 stands in for the default 1.5 s; the listing takes 250 ms (a per-call platform's 2-3 s).
    // The sync's own call timeout is max(sourceTimeoutMs, 5 s), so the listing would finish if it were let.
    const src = new Counted("mail", 4);
    let slow = false;
    const list = src.list.bind(src);
    // Honours its signal, as an MCP `callTool` does (the request is cancelled; the connector has already billed it).
    let started = 0;
    src.list = async (sc, cursor, limit, signal) => {
      started++;
      if (slow)
        await new Promise<void>((r, j) => {
          const t = setTimeout(r, 250);
          signal?.addEventListener("abort", () => (clearTimeout(t), j(new Error("aborted"))), { once: true });
        });
      return list(sc, cursor, limit);
    };
    let clock = T0;
    const partner = new ContextPartner({
      sources: async () => [src],
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => clock,
      onTrace: (t) => traces.push(t),
      config: {
        ...CORE_CONFIG,
        sync: true,
        syncOnDemand: true,
        syncPollBehind: true,
        syncPageSize: 10,
        syncCallsPerMin: 600,
        sourceTimeoutMs: 100,
      },
    });
    partner.sync!.track(scope);
    while (!partner.sync!.warm(scope)) await partner.sync!.tick();
    slow = true;
    clock += 7 * HOUR; // stale
    const lists0 = started;
    let current = 0;
    for (let i = 0; i < 4; i++) {
      clock += 60_000;
      await partner.ask({ ...scope, sessionId: `s${i}`, question: `quarterly plan note ${i} topic${i}?` });
      await new Promise((r) => setTimeout(r, 400)); // the listing has answered by now
      if (partner.sync!.current(scope, "mail")) current++;
    }
    // Expected: the first poll's call (made and billed) is let finish under the sync's own 5 s timeout, the source is
    // current, and the next three lookups list nothing. Before the fix: 4 listings, each cut off at the lookup's
    // deadline; the source never becomes current (only the daily sweep would make it so).
    expect({ lists: started - lists0, current }).toEqual({ lists: 1, current: 4 });
    // The listing outlived the lookup that sent it; its trace still holds the call (the review: it was counted only
    // when it answered, after the lookup had returned, so the traces summed to 0 calls against 1 received).
    expect(traces.reduce((n, t) => n + (t.syncCalls ?? 0), 0)).toBe(started - lists0);
  });

  test("a source with nothing synced is still read by the sweep (the review)", async () => {
    // An empty source warms; an item lands there later. With no timed polls, the daily sweep is how it is read in the
    // background: a cut of "nothing older than what is synced" with nothing synced stored nothing and marked it
    // current.
    const mail = new Counted("mail", 4);
    const docs = new Counted("docs", 0);
    let clock = T0;
    const cache = new ItemCache();
    const partner = new ContextPartner({
      sources: async () => [mail, docs],
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache,
      budget: new Budget(),
      model: null,
      now: () => clock,
      config: { ...CORE_CONFIG, sync: true, syncPageSize: 5, syncCallsPerMin: 6000, syncSweepMs: 24 * HOUR },
    });
    partner.sync!.track(scope);
    while (!partner.sync!.warm(scope)) await partner.sync!.tick();
    clock += 25 * HOUR;
    docs.items = [
      {
        id: itemId("docs", "d1"),
        sourceId: "docs",
        ref: "d1",
        title: "Plan",
        text: "The plan",
        updatedAt: clock - HOUR,
      },
    ];
    partner.sync!.track(scope);
    for (let i = 0; i < 5; i++) await partner.sync!.tick();
    expect(cache.isSynced(scope, itemId("docs", "d1"))).toBe(true);
  });
  test("the same, for event lookups that do not wait for the poll (syncPollBehind)", async () => {
    // `sourceTimeoutMs` 100 stands in for the default 1.5 s; the listing takes 250 ms (a per-call platform's 2-3 s).
    // The sync's own call timeout is max(sourceTimeoutMs, 5 s), so the listing would finish if it were let.
    const src = new Counted("mail", 4);
    let slow = false;
    const list = src.list.bind(src);
    // Honours its signal, as an MCP `callTool` does (the request is cancelled; the connector has already billed it).
    let started = 0;
    src.list = async (sc, cursor, limit, signal) => {
      started++;
      if (slow)
        await new Promise<void>((r, j) => {
          const t = setTimeout(r, 250);
          signal?.addEventListener("abort", () => (clearTimeout(t), j(new Error("aborted"))), { once: true });
        });
      return list(sc, cursor, limit);
    };
    let clock = T0;
    const partner = new ContextPartner({
      sources: async () => [src],
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => clock,
      config: {
        ...CORE_CONFIG,
        sync: true,
        syncOnDemand: true,
        syncPollBehind: true,
        syncPageSize: 10,
        syncCallsPerMin: 600,
        sourceTimeoutMs: 100,
      },
    });
    partner.sync!.track(scope);
    while (!partner.sync!.warm(scope)) await partner.sync!.tick();
    slow = true;
    clock += 7 * HOUR; // stale
    const lists0 = started;
    let current = 0;
    for (let i = 0; i < 4; i++) {
      clock += 60_000;
      await partner.observe(
        {
          ...scope,
          sessionId: `s${i}`,
          at: clock,
          kind: "user_message",
          text: `Draft the quarterly plan note ${i}`,
        } as never,
        { waitMs: 50 },
      );
      await new Promise((r) => setTimeout(r, 400)); // the listing has answered by now
      if (partner.sync!.current(scope, "mail")) current++;
    }
    // Expected: the first poll's call (made and billed) is let finish under the sync's own 5 s timeout, the source is
    // current, and the next three lookups list nothing. Before the fix: 4 listings, each cut off at the lookup's
    // deadline; the source never becomes current (only the daily sweep would make it so).
    expect({ lists: started - lists0, current }).toEqual({ lists: 1, current: 4 });
  });
});

test("a listing that never answers (its signal ignored) does not hold the source busy for good (the review)", async () => {
  const src = new Counted("mail", 4);
  let hang = false;
  const list = src.list.bind(src);
  src.list = (sc, cursor, limit) => (hang ? new Promise<ListPage>(() => {}) : list(sc, cursor, limit));
  let clock = T0;
  const partner = new ContextPartner({
    sources: async () => [src],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => clock,
    // The sync's call timeout is max(sourceTimeoutMs, 5 s); a read is let go after (20 pages + 1) of them.
    config: { ...CORE_CONFIG, sync: true, syncOnDemand: true, syncPageSize: 10, syncCallsPerMin: 600 },
  });
  partner.sync!.track(scope);
  while (!partner.sync!.warm(scope)) await partner.sync!.tick();
  const s = (partner.sync as unknown as { users: Map<string, { sources: Map<string, { busy: unknown }> }> }).users
    .get("t1/u1")!
    .sources.get("mail")!;
  hang = true;
  clock += 7 * HOUR;
  const realTimeout = globalThis.setTimeout;
  const timers: (() => void)[] = [];
  // The watchdog's timer fires at once here (its delay is 105 s of real time); every other timer runs as usual.
  globalThis.setTimeout = ((fn: () => void, ms?: number) =>
    ms !== undefined && ms >= 100_000 ? (timers.push(fn), 0) : realTimeout(fn, ms)) as typeof setTimeout;
  try {
    await partner.ask({ ...scope, sessionId: "s1", question: "quarterly plan note?" });
  } finally {
    globalThis.setTimeout = realTimeout;
  }
  expect(s.busy).not.toBeNull(); // the hung listing holds it
  for (const fn of timers) fn();
  expect(s.busy).toBeNull();
});
