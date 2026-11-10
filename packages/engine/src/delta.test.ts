/**
 * Trial `syncDelta` (D476, F1, docs/research/f1-local-copy.md): a source with a change feed (`Source.changes`) is
 * polled by one delta read, which brings changes wherever they sit in the listing and deletions, and vouches for
 * every copy held, so a change notice costs one delta read instead of a re-read of each doubted item.
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ChangePage, ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { CORE_CONFIG } from "./parts";
import { ContextPartner } from "./partner";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 20, 9);
const alice = { tenantId: "t1", userId: "alice" };
const bob = { tenantId: "t1", userId: "bob" };

/** A listing source with a change feed: the feed diffs against what it held at the last cursor it handed out. */
class FeedSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  readonly fetchReportsGone = true;
  readonly fetchesById = true;
  notifies = false;
  lists = 0;
  searches = 0;
  fetches = 0;
  deltas = 0;
  /** Set: the next read of the feed with a cursor says it expired. */
  expire = false;
  /** Set: listings fail. */
  failList = false;
  private cursor = 0;
  private held = new Map<string, string>();
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
    if (this.failList) throw new Error("listing down");
    const sorted = [...this.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
  async fetch(ref: string): Promise<ContextItem | null> {
    this.fetches++;
    return this.items.find((i) => i.ref === ref) ?? null;
  }
  async changes(_scope: Scope, cursor: string | undefined): Promise<ChangePage | null> {
    this.deltas++;
    const now = new Map(this.items.map((i) => [i.ref, `${i.title}\n${i.text}`]));
    const before = this.held;
    const was = this.cursor;
    this.held = now;
    this.cursor++;
    if (cursor === undefined) return { items: [], removed: [], next: String(this.cursor) };
    if (this.expire || Number(cursor) !== was) {
      this.expire = false;
      return null;
    }
    return {
      items: this.items.filter((i) => before.get(i.ref) !== now.get(i.ref)),
      removed: [...before.keys()].filter((ref) => !now.has(ref)),
      next: String(this.cursor),
    };
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

const ASKED = 15;
const REF = `i${ASKED}`;

/** A bank of 20 items, the asked one far below its newest page, and a filler source. */
function world() {
  const bank = new FeedSource(
    "bank",
    Array.from({ length: 20 }, (_, i) =>
      item("bank", i, i === ASKED ? "isa allowance statement for this year" : `card fees ${i}`),
    ),
  );
  const notes = new FeedSource("notes", [item("notes", 0, "filler sprint")]);
  return { bank, notes, all: [bank, notes] as Source[] };
}

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
      syncPush: true,
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

async function live(t: ReturnType<typeof setup>, scope: Scope, days: number): Promise<void> {
  for (let k = 0; k < (days * DAY) / (10 * MIN); k++) {
    t.advance(10 * MIN);
    t.partner.sync!.track(scope, t.now());
    await t.partner.sync!.tick();
  }
}

const ask = (p: ContextPartner, scope: Scope, sessionId: string) =>
  p.ask({ ...scope, sessionId, question: "Have I used my isa allowance?" });
const ON = { syncDelta: true };
const edit = (bank: FeedSource, text: string) =>
  (bank.items = bank.items.map((i) => (i.ref === REF ? { ...i, text } : i)));

describe("syncDelta (D476)", () => {
  test("off: the feed is never read", async () => {
    const { bank, all } = world();
    const t = setup(new Map([["alice", all]]), {});
    await warm(t.partner, alice);
    await live(t, alice, 1.1);
    expect(bank.deltas).toBe(0);
    expect(t.partner.sync!.hasDelta(alice, "bank")).toBe(false);
  });

  test("on: an old item changed in place is brought by one delta read, where a listing poll stops before it", async () => {
    for (const on of [false, true]) {
      const { bank, all } = world();
      const t = setup(new Map([["alice", all]]), on ? ON : {});
      await warm(t.partner, alice);
      expect(t.partner.sync!.hasDelta(alice, "bank")).toBe(on);
      // Changed in place, its time unchanged (a chat edit, a calendar event far down the listing).
      edit(bank, "isa allowance: 4,000 left this year");
      t.advance(8 * HOUR); // Past `syncMaxStaleMs`: the next lookup polls.
      const lists = bank.lists;
      const deltas = bank.deltas;
      const a = await ask(t.partner, alice, `s-${on}`);
      expect(a.citations.map((c) => c.itemId)).toContain(itemId("bank", REF));
      if (on) {
        expect(a.answer).toContain("4,000 left");
        expect(bank.deltas - deltas).toBe(1);
        expect(bank.lists).toBe(lists);
      } else expect(a.answer).not.toContain("4,000 left");
    }
  });

  test("on: a deletion reaches Eden with the next delta read, with no sweep", async () => {
    const { bank, all } = world();
    const t = setup(new Map([["alice", all]]), ON);
    await warm(t.partner, alice);
    bank.items = bank.items.filter((i) => i.ref !== REF);
    t.advance(8 * HOUR);
    const lists = bank.lists;
    const a = await ask(t.partner, alice, "s1");
    expect(a.citations.map((c) => c.itemId)).not.toContain(itemId("bank", REF));
    expect(t.cache.get(alice, itemId("bank", REF), t.now())).toBeNull();
    expect(bank.lists).toBe(lists);
  });

  test("on: a change notice costs one delta read, not a re-read of each doubted item", async () => {
    for (const on of [false, true]) {
      const { bank, all } = world();
      bank.notifies = true;
      const t = setup(new Map([["alice", all]]), on ? ON : {});
      await warm(t.partner, alice);
      edit(bank, "isa allowance: 4,000 left this year");
      expect(t.partner.sourceChanged(alice, "bank")).toBe(true);
      const fetches = bank.fetches;
      const deltas = bank.deltas;
      const a = await ask(t.partner, alice, `s-${on}`);
      expect(a.answer).toContain("4,000 left");
      if (on) {
        expect(bank.fetches).toBe(fetches);
        expect(bank.deltas - deltas).toBe(1);
      } else expect(bank.fetches).toBeGreaterThan(fetches);
    }
  });

  test("on: a notice during the delta read keeps the copies in doubt", async () => {
    const { bank, all } = world();
    bank.notifies = true;
    const t = setup(new Map([["alice", all]]), ON);
    await warm(t.partner, alice);
    const sync = t.partner.sync!;
    const mark = sync.mark();
    expect(t.partner.sourceChanged(alice, "bank")).toBe(true);
    const id = itemId("bank", REF);
    expect(sync.signalledSince(alice, "bank", mark, id)).toBe(true);
    // A read that began before the second notice does not cover it.
    const settling = sync.settleDelta(alice, bank, AbortSignal.timeout(5_000));
    t.partner.sourceChanged(alice, "bank");
    expect(await settling).toBe(true); // The second pass read again, after the notice.
    expect(sync.signalledSince(alice, "bank", mark, id)).toBe(false);
    // Only for a copy the sync holds: a lookup's own copy of an item it does not hold is not kept by the feed.
    expect(sync.signalledSince(alice, "bank", mark, itemId("bank", "elsewhere"))).toBe(true);
    expect(sync.signalledSince(alice, "bank", mark)).toBe(true);
    t.partner.sourceChanged(alice, "bank");
    expect(sync.signalledSince(alice, "bank", mark, id)).toBe(true);
  });

  test("on: an expired cursor is replaced and the source listed again; nothing is lost", async () => {
    const { bank, all } = world();
    const t = setup(new Map([["alice", all]]), ON);
    await warm(t.partner, alice);
    bank.expire = true;
    bank.items = bank.items.filter((i) => i.ref !== "i3");
    edit(bank, "isa allowance: 4,000 left this year");
    t.advance(8 * HOUR);
    await ask(t.partner, alice, "s1");
    expect(t.partner.sync!.hasDelta(alice, "bank")).toBe(false);
    const lists = bank.lists;
    // The next ticks take a new cursor and re-list; two sweeps drop what the source no longer lists.
    await live(t, alice, 2.5);
    expect(t.partner.sync!.hasDelta(alice, "bank")).toBe(true);
    expect(bank.lists).toBeGreaterThan(lists);
    expect(t.cache.get(alice, itemId("bank", "i3"), t.now())).toBeNull();
    const a = await ask(t.partner, alice, "s2");
    expect(a.answer).toContain("4,000 left");
  });

  test("on: a cursor taken over held copies vouches for nothing until a whole listing has ended (review)", async () => {
    const { bank, all } = world();
    bank.notifies = true;
    const t = setup(new Map([["alice", all]]), ON);
    await warm(t.partner, alice);
    await ask(t.partner, alice, "s0"); // The bank is used: its daily check is a delta read.
    edit(bank, "isa allowance: 4,000 left this year");
    expect(t.partner.sourceChanged(alice, "bank")).toBe(true);
    bank.expire = true;
    bank.failList = true;
    t.advance(25 * HOUR);
    t.partner.sync!.track(alice, t.now());
    await t.partner.sync!.tick(); // The background delta read: expired.
    t.advance(10 * MIN);
    t.partner.sync!.track(alice, t.now());
    await t.partner.sync!.tick(); // A new cursor; the whole listing fails.
    expect(t.partner.sync!.hasDelta(alice, "bank")).toBe(true);
    t.advance(40 * MIN);
    const fetches = bank.fetches;
    // The new feed knows nothing of the edit: the doubted copy is re-read by its ref, as without a feed.
    const a = await ask(t.partner, alice, "s1");
    expect(a.answer).toContain("4,000 left");
    expect(bank.fetches).toBeGreaterThan(fetches);
    // Once a whole listing has ended, the feed vouches again.
    bank.failList = false;
    await live(t, alice, 1.2);
    edit(bank, "isa allowance: 2,500 left this year");
    t.partner.sourceChanged(alice, "bank");
    const again = bank.fetches;
    expect((await ask(t.partner, alice, "s2")).answer).toContain("2,500 left");
    expect(bank.fetches).toBe(again);
  });

  test("on: a deleted item held only as a lookup's own copy is not cited after the feed reports it (review)", async () => {
    for (const on of [false, true]) {
      const { bank, all } = world();
      bank.notifies = true;
      // The cap keeps only the bank's newest ten: the asked item reaches the cache through a live search.
      const t = setup(new Map([["alice", all]]), { syncMaxItems: 10, syncLocalComplete: true, ...(on ? ON : {}) });
      await warm(t.partner, alice);
      const id = itemId("bank", REF);
      expect((await ask(t.partner, alice, "s0")).citations.map((c) => c.itemId)).toContain(id);
      bank.items = bank.items.filter((i) => i.ref !== REF);
      expect(t.partner.sourceChanged(alice, "bank")).toBe(true);
      t.advance(MIN);
      // The connector's search is down: only the cached copy could answer.
      bank.search = async () => {
        throw new Error("search down");
      };
      const a = await ask(t.partner, alice, "s1");
      expect(a.citations.map((c) => c.itemId)).not.toContain(id);
    }
  });

  test("on: a feed source is not re-listed daily, and deletions still go within the day", async () => {
    const { bank, all } = world();
    const t = setup(new Map([["alice", all]]), ON);
    await warm(t.partner, alice);
    const lists = bank.lists;
    await live(t, alice, 1.5);
    bank.items = bank.items.filter((i) => i.ref !== REF);
    await live(t, alice, 1.5);
    expect(bank.lists).toBe(lists);
    expect(t.cache.get(alice, itemId("bank", REF), t.now())).toBeNull();
  });

  test("on: two users' cursors and copies are apart", async () => {
    const a = world();
    const b = world();
    const t = setup(
      new Map([
        ["alice", a.all],
        ["bob", b.all],
      ]),
      ON,
    );
    await warm(t.partner, alice);
    await warm(t.partner, bob);
    edit(a.bank, "isa allowance: 4,000 left this year");
    t.advance(8 * HOUR);
    expect((await ask(t.partner, alice, "sa")).answer).toContain("4,000 left");
    const got = await ask(t.partner, bob, "sb");
    expect(got.answer).not.toContain("4,000 left");
    expect(got.citations.map((c) => c.itemId)).toContain(itemId("bank", REF));
  });

  test("on: every deletion a large feed page names is applied (review)", async () => {
    const { bank, all } = world();
    const t = setup(new Map([["alice", all]]), ON);
    await warm(t.partner, alice);
    // A mass deletion: past the 1,000 refs a read drops at once, the asked item among the last.
    const read = bank.changes.bind(bank);
    bank.changes = async (scope, cursor) => {
      const page = await read(scope, cursor);
      if (!page || cursor === undefined) return page;
      return { ...page, removed: [...Array.from({ length: 1_000 }, (_, i) => `gone${i}`), ...page.removed] };
    };
    bank.items = bank.items.filter((i) => i.ref !== REF);
    t.advance(8 * HOUR);
    const a = await ask(t.partner, alice, "s1");
    expect(a.citations.map((c) => c.itemId)).not.toContain(itemId("bank", REF));
  });
});
