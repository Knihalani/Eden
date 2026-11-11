/**
 * Trial `syncUnusedSweepMs` (D356, A21, docs/research/a21-scale.md): a source the user does not use is swept less
 * often, and a copy of its items that no sweep or read has vouched for within `syncSweepMs` is re-read before it is
 * delivered or cited, so a deletion the sweep has not seen yet (a lost notice) is caught first.
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { CORE_CONFIG } from "./parts";
import { ContextPartner } from "./partner";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 20, 9);
const alice = { tenantId: "t1", userId: "alice" };
const bob = { tenantId: "t1", userId: "bob" };

/** A newest-first listing source that counts its calls and fetches; items can be deleted at the source. */
class FetchSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  lists = 0;
  fetches = 0;
  /** Whether `fetch` can find an item at all (false: an MCP source with no get tool, which answers null to all). */
  readonly fetchesById: boolean;
  constructor(
    readonly id: string,
    public items: ContextItem[],
    readonly fetchReportsGone: boolean,
    withFetch: boolean | "null" = true,
  ) {
    if (!withFetch) (this as { fetch?: unknown }).fetch = undefined;
    this.fetchesById = withFetch === true;
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
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
    if (!this.fetchesById) return null;
    this.fetches++;
    return this.items.find((i) => i.ref === ref) ?? null;
  }
}

const item = (src: string, i: number, text: string): ContextItem => ({
  id: itemId(src, `i${i}`),
  sourceId: src,
  ref: `i${i}`,
  title: `${src} note ${i}`,
  text,
  updatedAt: T0 - (i + 1) * HOUR,
});

/**
 * A "bank" source of 20 items, the one asked about (`i15`) far below its newest page (a poll stops at the newest page
 * it already holds, so its copy is vouched for only by a sweep or a re-read), and three filler sources.
 */
function world(prefix = "", gone = true, withFetch: boolean | "null" = true) {
  const id = `${prefix}bank`;
  const rows = Array.from({ length: 20 }, (_, i) =>
    item(id, i, i === ASKED ? "isa allowance statement for this year" : `card fees ${i}`),
  );
  const bank = new FetchSource(id, rows, gone, withFetch);
  const filler = [1, 2, 3].map(
    (k) => new FetchSource(`${prefix}src${k}`, [item(`${prefix}src${k}`, 0, `filler sprint ${k}`)], gone, withFetch),
  );
  return { bank, all: [bank, ...filler] };
}

const ASKED = 15;
const REF = `i${ASKED}`;

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
    config: {
      ...CORE_CONFIG,
      sync: true,
      syncOnDemand: true,
      verifyDelivery: true,
      syncPageSize: 10,
      syncCallsPerMin: 6_000,
      routeLocalHits: true,
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

/** Runs `days` active days: the user is seen and the sync ticks every 10 minutes. */
async function live(t: ReturnType<typeof setup>, scope: Scope | Scope[], days: number): Promise<void> {
  for (let k = 0; k < (days * DAY) / (10 * MIN); k++) {
    t.advance(10 * MIN);
    for (const x of [scope].flat()) t.partner.sync!.track(x, t.now());
    await t.partner.sync!.tick();
  }
}

const ON = { syncUnusedSweepMs: 7 * DAY };
const cites = async (p: ContextPartner, scope: Scope, sessionId: string) =>
  (await p.ask({ ...scope, sessionId, question: "Have I used my isa allowance?" })).citations.map((c) => c.itemId);

describe("syncUnusedSweepMs (D356)", () => {
  test("off: every source is swept daily", async () => {
    const { bank, all } = world();
    const t = setup(new Map([["alice", all]]), {});
    await warm(t.partner, alice);
    const before = all.map((s) => s.lists);
    await live(t, alice, 3);
    for (let k = 0; k < all.length; k++) expect(all[k]!.lists - before[k]!).toBeGreaterThanOrEqual(3);
    expect(bank.lists).toBeGreaterThan(0);
  });

  test("on: an unused source with a fetch is swept weekly; one without a fetch stays daily", async () => {
    const { all } = world();
    const { all: nofetch } = world("n", true, false);
    const t = setup(new Map([["alice", [...all, ...nofetch]]]), ON);
    await warm(t.partner, alice);
    const before = [...all, ...nofetch].map((s) => s.lists);
    await live(t, alice, 3);
    const after = [...all, ...nofetch].map((s, k) => s.lists - before[k]!);
    for (const n of after.slice(0, all.length)) expect(n).toBe(0);
    for (const n of after.slice(all.length)) expect(n).toBeGreaterThanOrEqual(3);
    await live(t, alice, 5);
    for (const s of all) expect(s.lists - before[all.indexOf(s)]!).toBeGreaterThanOrEqual(1);
  });

  test("on: a deletion with a lost notice is caught by the re-read before the ask cites it", async () => {
    for (const on of [false, true]) {
      const { bank, all } = world();
      const t = setup(new Map([["alice", all]]), on ? ON : {});
      await warm(t.partner, alice);
      await live(t, alice, 2);
      // Deleted at the source; the integrator's notice is lost. The daily sweep (off) needs two misses to drop it.
      bank.items = bank.items.filter((i) => i.ref !== REF);
      const fetches = bank.fetches;
      const got = await cites(t.partner, alice, `s-${on}`);
      if (on) {
        expect(got).not.toContain(itemId("bank", REF));
        expect(bank.fetches).toBeGreaterThan(fetches);
      } else expect(got).toContain(itemId("bank", REF));
    }
  });

  test("on: a null that proves nothing withholds the copy and makes the sweep due", async () => {
    const { bank, all } = world("", false);
    const t = setup(new Map([["alice", all]]), ON);
    await warm(t.partner, alice);
    await live(t, alice, 2);
    bank.items = bank.items.filter((i) => i.ref !== REF);
    const reply = await t.partner.ask({ ...alice, sessionId: "s1", question: "Have I used my isa allowance?" });
    expect(reply.citations.map((c) => c.itemId)).not.toContain(itemId("bank", REF));
    expect(reply.answer).toContain("no recent listing of their source confirms them");
    const lists = bank.lists;
    t.advance(MIN);
    t.partner.sync!.track(alice, t.now());
    await t.partner.sync!.tick();
    expect(bank.lists).toBeGreaterThan(lists);
    // That sweep missed it once (two misses drop it): still not cited, and the next early sweep drops it.
    expect(t.partner.sync!.sweepMissed(alice, "bank", itemId("bank", REF))).toBe(true);
    expect(await cites(t.partner, alice, "s2")).not.toContain(itemId("bank", REF));
    t.advance(MIN);
    t.partner.sync!.track(alice, t.now());
    await t.partner.sync!.tick();
    expect(t.cache.get(alice, itemId("bank", REF), t.now()) ?? undefined).toBeUndefined();
    expect(t.partner.sync!.syncedIds(alice, "bank")).not.toContain(itemId("bank", REF));
  });

  test("on: a copy a sweep missed but a re-read finds is cited, and not re-read again", async () => {
    const { bank, all } = world();
    const t = setup(new Map([["alice", all]]), ON);
    await warm(t.partner, alice);
    // The source hides the item from one listing (an offset shift): the sweep misses it once.
    const kept = bank.items;
    bank.items = kept.filter((i) => i.ref !== REF);
    t.partner.sync!.sweepSoon(alice, "bank");
    t.partner.sync!.track(alice, t.now());
    await t.partner.sync!.tick();
    bank.items = kept;
    expect(t.partner.sync!.sweepMissed(alice, "bank", itemId("bank", REF))).toBe(true);
    const f0 = bank.fetches;
    expect(await cites(t.partner, alice, "s1")).toContain(itemId("bank", REF));
    expect(bank.fetches).toBe(f0 + 1);
    expect(t.partner.sync!.sweepMissed(alice, "bank", itemId("bank", REF))).toBe(false);
    t.advance(HOUR);
    expect(await cites(t.partner, alice, "s2")).toContain(itemId("bank", REF));
    expect(bank.fetches).toBe(f0 + 1);
  });

  test("on: a confirmed re-read is cited, and vouches for the copy for a day", async () => {
    const { bank, all } = world();
    const t = setup(new Map([["alice", all]]), ON);
    await warm(t.partner, alice);
    await live(t, alice, 2);
    const f0 = bank.fetches;
    expect(await cites(t.partner, alice, "s1")).toContain(itemId("bank", REF));
    expect(bank.fetches).toBeGreaterThan(f0);
    const f1 = bank.fetches;
    t.advance(HOUR);
    expect(await cites(t.partner, alice, "s2")).toContain(itemId("bank", REF));
    expect(bank.fetches).toBe(f1);
  });

  test("on: an idle user's late daily sweep doubts nothing (only a sweep the trial skipped does)", async () => {
    const { bank, all } = world();
    const t = setup(new Map([["alice", all]]), ON);
    await warm(t.partner, alice);
    // Two days with no event: no sweep runs for an idle user, with or without the trial.
    for (let k = 0; k < (2 * DAY) / (10 * MIN); k++) {
      t.advance(10 * MIN);
      await t.partner.sync!.tick();
    }
    expect(t.partner.sync!.sweepLapsed(alice, "bank")).toBe(false);
    const f0 = bank.fetches;
    expect(await cites(t.partner, alice, "s1")).toContain(itemId("bank", REF));
    expect(bank.fetches).toBe(f0);
  });

  test("on: a copy younger than the daily sweep is not re-read", async () => {
    const { bank, all } = world();
    const t = setup(new Map([["alice", all]]), ON);
    await warm(t.partner, alice);
    await live(t, alice, 0.5);
    const f0 = bank.fetches;
    expect(await cites(t.partner, alice, "s1")).toContain(itemId("bank", REF));
    expect(bank.fetches).toBe(f0);
  });

  test("one user's withheld copy makes only their sweep due (isolation)", async () => {
    // The same source ids for both users: state keyed by source alone would leak.
    const a = world("", false);
    const b = world("", false);
    const t = setup(
      new Map([
        ["alice", a.all],
        ["bob", b.all],
      ]),
      ON,
    );
    await warm(t.partner, alice);
    await warm(t.partner, bob);
    await live(t, [alice, bob], 2);
    expect(t.partner.sync!.sweepLapsed(bob, "bank")).toBe(true);
    a.bank.items = a.bank.items.filter((i) => i.ref !== REF);
    await cites(t.partner, alice, "s1");
    const bobLists = b.bank.lists;
    t.advance(MIN);
    // Bob is active but his source's sweep is not due (weekly): only alice's was made due.
    t.partner.sync!.track(alice, t.now());
    t.partner.sync!.track(bob, t.now());
    await t.partner.sync!.tick();
    expect(b.bank.lists).toBe(bobLists);
    // Alice's withheld copy was missed by her early sweep; bob's copy of the same id was not.
    expect(t.partner.sync!.sweepMissed(alice, "bank", itemId("bank", REF))).toBe(true);
    expect(t.partner.sync!.sweepMissed(bob, "bank", itemId("bank", REF))).toBe(false);
    expect(t.partner.sync!.sweepLapsed(bob, "bank")).toBe(true);
  });

  test("on: a copy one sweep missed, from a source whose fetch cannot confirm it, is cited as before", async () => {
    const { bank, all } = world("", false, "null");
    const t = setup(new Map([["alice", all]]), ON);
    await warm(t.partner, alice);
    const kept = bank.items;
    bank.items = kept.filter((i) => i.ref !== REF);
    await live(t, alice, 1.1);
    bank.items = kept;
    expect(t.partner.sync!.sweepMissed(alice, "bank", itemId("bank", REF))).toBe(false);
    expect(await cites(t.partner, alice, "s1")).toContain(itemId("bank", REF));
  });

  test("on: an MCP source with no get tool (fetch answers null to all) keeps the daily sweep and is cited", async () => {
    for (const on of [false, true]) {
      const { bank, all } = world("", false, "null");
      const t = setup(new Map([["alice", all]]), on ? ON : {});
      await warm(t.partner, alice);
      const before = bank.lists;
      await live(t, alice, 3);
      expect(bank.lists - before).toBeGreaterThanOrEqual(3);
      expect(t.partner.sync!.sweepLapsed(alice, "bank")).toBe(false);
      const reply = await t.partner.ask({ ...alice, sessionId: `s-${on}`, question: "Have I used my isa allowance?" });
      expect(reply.citations.map((c) => c.itemId)).toContain(itemId("bank", REF));
      expect(reply.answer).not.toContain("Left out");
    }
  });

  test("syncSweepSpread (D604): unused sources are swept at their own points in the week, at no extra sweep", async () => {
    const days = async (spread: boolean) => {
      const make = () => Array.from({ length: 40 }, (_, k) => new FetchSource(`s${k}`, [item(`s${k}`, 0, "x")], true));
      const mine = make();
      const theirs = make();
      const t = setup(
        new Map([
          ["alice", mine],
          ["bob", theirs],
        ]),
        { ...ON, syncSweepSpread: spread },
      );
      let ready = 0;
      const real = t.cache.ready.bind(t.cache);
      t.cache.ready = (scope) => {
        ready++;
        return real(scope);
      };
      await warm(t.partner, alice);
      await warm(t.partner, bob);
      // The day (after the backfill) of each source's sweeps over four weeks.
      const seen = [...mine, ...theirs].map(() => [] as number[]);
      const counts = [...mine, ...theirs].map((x) => x.lists);
      for (let day = 0; day < 28; day++) {
        const before = ready;
        await live(t, [alice, bob], 1);
        let swept = false;
        [...mine, ...theirs].forEach((x, k) => {
          for (; counts[k]! < x.lists; counts[k]!++, swept = true) seen[k]!.push(day);
        });
        // A sweep reads the cache: the user's frozen cache is waited for first (D325).
        if (swept) expect(ready).toBeGreaterThan(before);
      }
      return { alice: seen.slice(0, 40), bob: seen.slice(40) };
    };
    const off = await days(false);
    // Off: every source a week after the backfill, in the same tick.
    for (const d of off.alice) expect(d).toEqual([6, 13, 20, 27]);
    const on = await days(true);
    const perDay = Array.from({ length: 28 }, (_, day) => on.alice.filter((d) => d.includes(day)).length);
    expect(Math.max(...perDay)).toBeLessThan(20);
    for (const d of [...on.alice, ...on.bob]) {
      // The first 4 to 11 days after the backfill, then weekly: never more sweeps than off, never a longer gap.
      expect(d[0]!).toBeGreaterThanOrEqual(3);
      expect(d[0]!).toBeLessThanOrEqual(11);
      expect(d.length).toBeLessThanOrEqual(4);
      expect(d.length).toBeGreaterThanOrEqual(3);
      for (let k = 1; k < d.length; k++) expect(d[k]! - d[k - 1]!).toBe(7);
    }
    // No more listings than off over the four weeks.
    expect(on.alice.flat().length).toBeLessThanOrEqual(off.alice.flat().length);
    // Another user's sources of the same ids have points of their own.
    expect(on.alice.filter((d, k) => d[0] === on.bob[k]![0]).length).toBeLessThan(20);
  });
});
