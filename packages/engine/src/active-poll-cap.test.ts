import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { checkEngineConfig } from "./config-check";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

// `syncActivePollCap` (D1747, trial): the freshness floor (D1131) polls every first-party source of an active user;
// at a thousand connectors that was about a thousand calls an active day (call-causes, D1746). With the cap the used
// sources keep the floor and the others share an allowance of `cap` floor polls an interval, likeliest first.

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 2, 9);

class Notes implements Source {
  readonly kind = "test";
  readonly description = "notes";
  readonly callPriced = false;
  docs = new Map<string, { text: string; at: number }>();
  lists = 0;
  constructor(readonly id: string) {}
  item(ref: string): ContextItem {
    const d = this.docs.get(ref)!;
    return { id: itemId(this.id, ref), sourceId: this.id, ref, title: ref, text: d.text, updatedAt: d.at };
  }
  async search(_q: SearchQuery): Promise<ContextItem[]> {
    return [];
  }
  async list(_s: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    this.lists++;
    const all = [...this.docs.keys()].map((r) => this.item(r)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: all.slice(at, at + limit), next: at + limit < all.length ? String(at + limit) : null };
  }
}

const A: Scope = { tenantId: "t", userId: "a" };
const B: Scope = { tenantId: "t", userId: "b" };

/**
 * Two users with `n` notes sources each; source `k` holds items dated `ageH(k)` hours back, so its learned change rate
 * (the backfill's prior) is set by how recent its items are.
 */
async function setup(cap: number, n: number, ageH: (k: number) => number = () => 24 * 30) {
  const clock = { now: T0 };
  const mk = () =>
    Array.from({ length: n }, (_, k) => {
      const s = new Notes(`notes-${k}`);
      for (let j = 0; j < 3; j++) s.docs.set(`n${j}`, { text: `note ${j}`, at: T0 - (ageH(k) + j) * 60 * MIN });
      return s;
    });
  const src = { a: mk(), b: mk() };
  const cache = new ItemCache();
  // Thaws the floor asks for (`ready`): one a tick a due source opens the floor's block.
  const thaws = { n: 0 };
  const ready = cache.ready.bind(cache);
  cache.ready = (scope: Scope) => (thaws.n++, ready(scope));
  const partner = new ContextPartner({
    sources: async (scope) => (scope.userId === "a" ? src.a : src.b),
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache,
    budget: new Budget(),
    model: null,
    now: () => clock.now,
    config: {
      ...CORE_CONFIG,
      sync: true,
      syncPageSize: 10,
      syncActivePollMs: 10 * MIN,
      syncActivePollCap: cap,
    },
  });
  const sync = partner.sync!;
  for (const scope of [A, B]) sync.track(scope, clock.now);
  while (!sync.warm(A) || !sync.warm(B)) await sync.tick();
  const tick = async (minutes: number, scopes: Scope[] = [A, B]) => {
    for (let m = 0; m < minutes; m++) {
      clock.now += MIN;
      for (const scope of scopes) sync.track(scope, clock.now);
      await sync.tick();
    }
  };
  const lists = (xs: Notes[]) => xs.map((x) => x.lists);
  const since = (xs: Notes[], before: number[]) => xs.map((x, k) => x.lists - before[k]!);
  const held = (scope: Scope, k: number, ref: string) => cache.get(scope, itemId(`notes-${k}`, ref), clock.now)?.text;
  return { clock, src, sync, tick, lists, since, held, thaws };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("syncActivePollCap (D1747)", () => {
  test("off (0): every quiet source keeps the floor", async () => {
    const t = await setup(0, 30);
    const before = t.lists(t.src.a);
    await t.tick(60);
    // A 10-minute floor over an hour: each of the 30 sources is polled at least once.
    expect(t.since(t.src.a, before).every((x) => x >= 1)).toBe(true);
  });

  test("on: the user's unused sources share the allowance, about `cap` polls a floor interval", async () => {
    const t = await setup(5, 30);
    const before = t.lists(t.src.a);
    await t.tick(60);
    const made = sum(t.since(t.src.a, before));
    // Six intervals of 5, plus the first full allowance: at most 35, against at least 30 an interval without it.
    expect(made).toBeGreaterThanOrEqual(5);
    expect(made).toBeLessThanOrEqual(35);
  });

  test("a used source keeps the floor whatever the allowance says", async () => {
    const t = await setup(2, 30);
    t.sync.engage(A, ["notes-7"]);
    const before = t.lists(t.src.a);
    t.src.a[7]!.docs.set("n1", { text: "note 1 MOVED to Friday", at: t.clock.now });
    await t.tick(30);
    expect(t.held(A, 7, "n1")).toBe("note 1 MOVED to Friday");
    expect(t.since(t.src.a, before)[7]).toBeGreaterThanOrEqual(1);
  });

  test("the likeliest to have changed go first: a source with recent items before a dormant one", async () => {
    // Source 29's items are an hour old (a high learned rate); the other 29 are a month old. Last in the user's list,
    // so only the ordering puts it first.
    const t = await setup(1, 30, (k) => (k === 29 ? 1 : 24 * 30));
    const before = t.lists(t.src.a);
    await t.tick(25);
    const made = t.since(t.src.a, before);
    expect(made[29]).toBeGreaterThanOrEqual(2);
    expect(sum(made)).toBeLessThanOrEqual(5);
  });

  test("no source starves: a dormant one is polled in time as its chance of a change grows", async () => {
    const t = await setup(3, 12);
    const before = t.lists(t.src.a);
    await t.tick(24 * 60);
    expect(t.since(t.src.a, before).every((x) => x >= 1)).toBe(true);
  });

  test("a due unused source with the allowance spent does not thaw the user (D325)", async () => {
    const t = await setup(1, 30);
    await t.tick(30, [A]);
    const thaws = t.thaws.n;
    await t.tick(60, [A]);
    // Six refills of one poll in an hour: a couple of thaws each, not every tick (the first form asked 120).
    expect(t.thaws.n - thaws).toBeLessThanOrEqual(15);
  });

  test("isolation: one user's spent allowance does not hold back another's floor", async () => {
    const t = await setup(3, 12);
    // A is active for an hour first and spends its allowance; B then gets its own in full.
    await t.tick(60, [A]);
    const before = t.lists(t.src.b);
    t.src.b[4]!.docs.set("n0", { text: "note 0 for b only", at: t.clock.now });
    await t.tick(10, [A, B]);
    expect(sum(t.since(t.src.b, before))).toBeGreaterThanOrEqual(3);
    expect(t.held(A, 4, "n0")).toBe("note 0");
  });

  test("config: the cap needs the floor on", () => {
    expect(() => checkEngineConfig({ syncActivePollMs: 0, syncActivePollCap: 40 })).toThrow(/above 0/);
    expect(checkEngineConfig({ syncActivePollCap: 40 })).toEqual({ syncActivePollCap: 40 });
    expect(() => checkEngineConfig({ syncActivePollCap: 2.5 })).toThrow();
  });
});
