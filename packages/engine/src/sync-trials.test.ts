import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { checkEngineConfig } from "./config-check";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { maxAgeMs } from "./sync";

// The S4 sync trials: D213 (`syncCoalesceMs`, a poll window per user and source) and D214 (per-source recency caps).

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 2, 9);

/** A newest-first, notifying listing source that counts its list calls. */
class Lister implements Source {
  readonly kind = "test";
  readonly description = "test";
  readonly listsByTime = true;
  readonly notifies = true;
  lists = 0;
  items: ContextItem[] = [];
  constructor(readonly id: string) {}
  add(ref: string, at: number): void {
    this.items.push({
      id: itemId(this.id, ref),
      sourceId: this.id,
      ref,
      title: `Note ${ref}`,
      text: `Note ${ref} body`,
      updatedAt: at,
    });
  }
  async search(_q: SearchQuery): Promise<ContextItem[]> {
    return [];
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    this.lists++;
    const sorted = [...this.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
}

const scope = { tenantId: "t1", userId: "u1" };

async function setup(src: Lister, config: Record<string, unknown>) {
  let clock = T0;
  const cache = new ItemCache();
  const p = new ContextPartner({
    sources: async () => [src],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache,
    budget: new Budget(),
    model: null,
    now: () => clock,
    config: {
      ...CORE_CONFIG,
      sync: true,
      syncPush: true,
      syncOnDemand: true,
      syncPageSize: 10,
      syncCallsPerMin: 600,
      ...config,
    },
  });
  p.sync!.track(scope, clock);
  while (!p.sync!.warm(scope)) await p.sync!.tick();
  return { p, cache, advance: (ms: number) => (clock += ms), now: () => clock };
}

/** The on-demand poll a lookup makes (`freshen`), as a lookup's slow path calls it. */
const lookup = async (p: ContextPartner, src: Source) => p.sync!.freshen(scope, [src], new AbortController().signal);

describe("syncCoalesceMs: one poll per window per user and source (D213)", () => {
  test("off (the default): each signal after a poll makes the next lookup poll again", async () => {
    const src = new Lister("mail");
    src.add("a", T0 - DAY);
    const { p, advance } = await setup(src, {});
    const before = src.lists;
    for (let i = 0; i < 3; i++) {
      p.sourceChanged(scope, "mail");
      advance(2_000);
      await lookup(p, src);
    }
    expect(src.lists - before).toBe(3);
  });

  test("on: signals within the window after a poll cost no second call; the first lookup after it polls", async () => {
    const src = new Lister("mail");
    src.add("a", T0 - DAY);
    const { p, advance } = await setup(src, { syncCoalesceMs: 30_000 });
    advance(60_000); // past the window the backfill's end opened
    p.sourceChanged(scope, "mail");
    advance(1_000);
    const before = src.lists;
    await lookup(p, src);
    expect(src.lists - before).toBe(1);
    for (let i = 0; i < 3; i++) {
      p.sourceChanged(scope, "mail");
      advance(2_000);
      await lookup(p, src);
    }
    expect(src.lists - before).toBe(1);
    // Past the window the pending notice is read.
    advance(30_000);
    await lookup(p, src);
    expect(src.lists - before).toBe(2);
    // ... and a source with nothing pending stays current.
    advance(1_000);
    await lookup(p, src);
    expect(src.lists - before).toBe(2);
  });

  test("the window is per user: another user's poll does not cover this one", async () => {
    const src = new Lister("mail");
    src.add("a", T0 - DAY);
    const { p, advance } = await setup(src, { syncCoalesceMs: 30_000 });
    const other = { tenantId: "t1", userId: "u2" };
    p.sync!.track(other);
    while (!p.sync!.warm(other)) await p.sync!.tick();
    advance(60_000);
    p.sourceChanged(scope, "mail");
    p.sourceChanged(other, "mail");
    advance(1_000);
    const before = src.lists;
    await lookup(p, src);
    await p.sync!.freshen(other, [src], new AbortController().signal);
    expect(src.lists - before).toBe(2);
  });
});

describe("per-source recency caps (D214)", () => {
  function aged(n: number, id = "mail"): Lister {
    const src = new Lister(id);
    // One item a day back from T0: m0 today, m1 yesterday, ...
    for (let i = 0; i < n; i++) src.add(`m${i}`, T0 - i * DAY - 60_000);
    return src;
  }
  const synced = (cache: ItemCache, src: Lister, now: number) =>
    src.items.filter((it) => (cache.get(scope, it.id, now) ?? null) !== null).length;

  test("off (the default): the backfill lists and syncs everything", async () => {
    const src = aged(60);
    const { cache, now } = await setup(src, {});
    expect(synced(cache, src, now())).toBe(60);
    expect(src.lists).toBe(6);
  });

  test("a 30-day cap: only the last 30 days are synced, and the backfill stops paging past them", async () => {
    const src = aged(60);
    const { cache, now } = await setup(src, { syncMaxAgeDays: 30 });
    expect(synced(cache, src, now())).toBe(30);
    expect(src.lists).toBe(4); // pages to day 39; the fourth reaches past day 30 and ends it
  });

  test("per source: one capped, one not, and 0 lifts a global cap", async () => {
    const mail = aged(60, "mail");
    const { cache, now } = await setup(mail, { syncMaxAgeDays: 30, syncMaxAgeBySource: ["mail:0"] });
    expect(synced(cache, mail, now())).toBe(60);
    const chat = aged(60, "chat");
    const c = await setup(chat, { syncMaxAgeBySource: ["chat:10"] });
    expect(synced(c.cache, chat, c.now())).toBe(10);
  });

  test("an item that ages past the cap is dropped at the next sweep", async () => {
    const src = aged(20);
    const { p, cache, advance, now } = await setup(src, {
      syncMaxAgeDays: 30,
      syncSweepMs: DAY,
      syncActiveMs: 30 * DAY,
    });
    expect(synced(cache, src, now())).toBe(20);
    advance(15 * DAY);
    p.sync!.track(scope, now());
    await p.sync!.tick();
    // Items more than 30 days old by now (m15 to m19) are gone; the rest stay.
    expect(synced(cache, src, now())).toBe(15);
  });

  test("maxAgeMs: none when nothing is capped; the last entry for a source wins", () => {
    expect(maxAgeMs(0, [])).toBeUndefined();
    expect(maxAgeMs(0, ["mail:0"])).toBeUndefined();
    const f = maxAgeMs(30, ["slack:7", "slack:14", "crm:0"])!;
    expect(f("slack")).toBe(14 * DAY);
    expect(f("crm")).toBe(Infinity);
    expect(f("gmail")).toBe(30 * DAY);
    expect(maxAgeMs(0, ["a:b:2"])!("a:b")).toBe(2 * DAY);
  });

  test("the config check refuses a malformed entry, and both keys need sync on", () => {
    expect(() => checkEngineConfig({ syncMaxAgeBySource: ["mail"] })).toThrow(/<sourceId>:<days>/);
    expect(() => checkEngineConfig({ syncMaxAgeBySource: ["mail:-1"] })).toThrow(/<sourceId>:<days>/);
    expect(checkEngineConfig({ syncMaxAgeBySource: ["mail:30"], syncCoalesceMs: 5_000 })).toEqual({
      syncMaxAgeBySource: ["mail:30"],
      syncCoalesceMs: 5_000,
    });
    expect(() => checkEngineConfig({ sync: false, syncMaxAgeDays: 30 })).toThrow(/acts only with "sync"/);
  });
});
