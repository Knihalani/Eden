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
  failLists = false;
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

describe("background sync (D56)", () => {
  test("off by default: no sync, no list call, the lookup searches live", async () => {
    const src = new ListSource("mail", mail(3));
    const p = new ContextPartner({
      sources: async () => [src],
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
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
    const lookup = traces.find((t) => t.localSources !== undefined);
    if (lookup) expect(lookup.sourceCalls).toBe(0);
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

  test("with on-demand polls off, a stale source is searched live as before", async () => {
    const src = new ListSource("mail", mail(4));
    const { partner, advance, now } = setup([src], { syncOnDemand: false, syncMaxStaleMs: 4 * HOUR });
    partner.sync!.track(scope);
    while (!partner.sync!.warm(scope)) await partner.sync!.tick();
    advance(5 * HOUR);
    await say(partner, "Where is the quarterly plan?", scope, "s1", now());
    expect(src.searches).toBeGreaterThan(0);
  });

  test("a sweep drops what the source no longer lists (delete propagation)", async () => {
    const src = new ListSource("mail", mail(5));
    const { partner, cache, advance, now } = setup([src], { syncSweepMs: HOUR });
    partner.sync!.track(scope);
    while (!partner.sync!.warm(scope)) await partner.sync!.tick();
    expect(cache.get(scope, itemId("mail", "m3"), now())).not.toBeNull();
    src.items = src.items.filter((i) => i.ref !== "m3");
    advance(2 * HOUR);
    partner.sync!.track(scope); // Still active: sweeps run for active users only.
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

describe("item cache: synced items (D56)", () => {
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
