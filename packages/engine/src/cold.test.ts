/**
 * Trial `syncCold` (D475, F1, docs/research/f1-local-copy.md): the items a user's cap pushes out of the index are
 * kept compressed in a cold tier, so a "cut" copy is whole here and its source is not searched live on a lookup.
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ColdPack, coldQuery, type ColdEntry } from "./cold";
import { CORE_CONFIG } from "./parts";
import { ContextPartner } from "./partner";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 20, 9);
const alice = { tenantId: "t1", userId: "alice" };
const bob = { tenantId: "t1", userId: "bob" };

class ListSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  readonly fetchReportsGone = true;
  readonly fetchesById = true;
  lists = 0;
  searches = 0;
  fetches = 0;
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

const entry = (it: ContextItem, fetchedAt = T0, readMark = 0): ColdEntry => ({ item: it, fetchedAt, readMark });

describe("ColdPack", () => {
  test("holds copies compressed, finds them by a word, and tells an unchanged copy from a changed one", () => {
    const pack = new ColdPack();
    const rows = Array.from({ length: 200 }, (_, i) =>
      item(
        "wiki",
        i,
        i === 137
          ? "the boiler warranty expires in march"
          : `sprint retro notes ${i}: ` + Array.from({ length: 60 }, (_, k) => `topic${(i * 7 + k) % 90}`).join(" "),
      ),
    );
    pack.add(rows.map((r) => entry(r)));
    expect(pack.size).toBe(200);
    expect(pack.has(rows[137]!.id)).toBe(true);
    expect(pack.holds(rows[137]!)).toBe(true);
    expect(pack.holds({ ...rows[137]!, text: "the boiler warranty expired" })).toBe(false);
    const opened = { chunks: 0 };
    const hits = pack.match(coldQuery("When does the boiler warranty expire?"), 8, 8, opened);
    expect(hits.map((h) => h.item.id)).toEqual([rows[137]!.id]);
    // Only the chunk whose filter holds the words is opened (the others' filters may match falsely, rarely).
    expect(opened.chunks).toBeLessThanOrEqual(2);
    expect(pack.match(coldQuery("zebra crossing"), 8, 8)).toEqual([]);
    // Far smaller than the text it holds.
    const raw = rows.reduce((n, r) => n + r.title.length + r.text.length, 0);
    expect(pack.bytes).toBeLessThan(raw);
  });

  test("a dropped id is gone; a replaced copy is the only one read; the pack rewrites itself", () => {
    const pack = new ColdPack();
    const rows = Array.from({ length: 150 }, (_, i) => item("wiki", i, `quarterly budget line ${i}`));
    pack.add(rows.map((r) => entry(r)));
    expect(pack.drop(rows[3]!.id)).toBe(true);
    expect(pack.drop(rows[3]!.id)).toBe(false);
    expect(pack.has(rows[3]!.id)).toBe(false);
    pack.add([entry({ ...rows[5]!, text: "quarterly budget line five, revised" }, T0 + 1, 7)]);
    expect(pack.size).toBe(149);
    const five = pack.entries().filter((e) => e.item.id === rows[5]!.id);
    expect(five.length).toBe(1);
    expect(five[0]!.item.text).toContain("revised");
    expect(five[0]!.readMark).toBe(7);
    for (const r of rows.slice(10, 140)) pack.drop(r.id);
    expect(pack.size).toBe(19);
    expect(pack.entries().length).toBe(19);
    expect(pack.ids().length).toBe(19);
  });
});

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
      syncLocalComplete: true,
      syncKeepCut: true,
      verifyDelivery: true,
      syncPageSize: 10,
      syncMaxItems: 20,
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

const ASKED = 5;
const REF = `i${ASKED}`;

/** A mailbox whose newest 20 items fill the user's cap, and a bank of 30 older items, the asked one among them. */
function world() {
  const mail = new ListSource(
    "mail",
    Array.from({ length: 20 }, (_, i) => item("mail", i, `lunch plans ${i}`, T0 - (i + 1) * MIN)),
  );
  const bank = new ListSource(
    "bank",
    Array.from({ length: 30 }, (_, i) =>
      item("bank", i, i === ASKED ? "isa allowance statement for this year" : `card fees ${i}`, T0 - DAY - i * HOUR),
    ),
  );
  return { mail, bank, all: [mail, bank] as Source[] };
}

const ask = (p: ContextPartner, scope: Scope, sessionId: string) =>
  p.ask({ ...scope, sessionId, question: "Have I used my isa allowance?" });
const ON = { syncCold: true, syncColdMaxItems: 1_000 };

describe("syncCold (D475)", () => {
  test("off: the cut copy is searched live on every ask", async () => {
    const { bank, all } = world();
    const t = setup(new Map([["alice", all]]), {});
    await warm(t.partner, alice);
    expect(t.partner.sync!.complete(alice, "bank")).toBe(false);
    const a = await ask(t.partner, alice, "s1");
    expect(a.citations.map((c) => c.itemId)).toContain(itemId("bank", REF));
    expect(bank.searches).toBeGreaterThan(0);
    expect(t.partner.sync!.coldStats(alice).items).toBe(0);
  });

  test("on: the copy is whole, the ask cites the cold item, and no source is searched", async () => {
    const { mail, bank, all } = world();
    const t = setup(new Map([["alice", all]]), ON);
    await warm(t.partner, alice);
    const cold = t.partner.sync!.coldStats(alice);
    // The bank's 30 items are older than the mailbox's 20: what the trim let go of is cold, the rest indexed.
    expect(cold.items).toBe(20);
    expect(cold.bytes).toBeGreaterThan(0);
    expect(t.partner.sync!.complete(alice, "bank")).toBe(true);
    expect(t.cache.get(alice, itemId("bank", REF), t.now())).toBeNull();
    const a = await ask(t.partner, alice, "s1");
    expect(a.citations.map((c) => c.itemId)).toContain(itemId("bank", REF));
    expect(bank.searches + mail.searches).toBe(0);
    expect(a.sources?.every((x) => x.status === "local")).toBe(true);
    // Back in the index as a synced item, no longer cold.
    expect(t.cache.isSynced(alice, itemId("bank", REF))).toBe(true);
    expect(t.partner.sync!.coldStats(alice).items).toBe(19);
    expect(t.partner.sync!.stats.coldThawed).toBe(1);
  });

  test("on: a copy brought back is re-read before it is cited, as the live search it replaces read it", async () => {
    const { bank, all } = world();
    const t = setup(new Map([["alice", all]]), ON);
    await warm(t.partner, alice);
    const read = t.now();
    t.advance(MIN); // Still current: the ask's lookup does not poll (a listing showing the item would vouch for it).
    // Back in the index with the time it was read at, not now's (`putBack`): its age is what the checks doubt.
    const sync = t.partner.sync!;
    expect(sync.thaw(alice, ["bank"], coldQuery("isa allowance"), 8, t.now()).length).toBe(1);
    expect(t.cache.fetchedAt(alice, itemId("bank", REF))).toBe(read);
    expect(sync.thawedUnread(alice, "bank", itemId("bank", REF))).toBe(true);
    const a = await ask(t.partner, alice, "s1");
    expect(a.citations.map((c) => c.itemId)).toContain(itemId("bank", REF));
    expect(bank.fetches).toBe(1);
    expect(bank.searches).toBe(0);
    expect(sync.thawedUnread(alice, "bank", itemId("bank", REF))).toBe(false);
    // Once read at its source it is a synced copy like any other: no second re-read.
    await ask(t.partner, alice, "s2");
    expect(bank.fetches).toBe(1);
  });

  test("on: a cold item deleted at its source with no notice is not cited, before any sweep has seen it", async () => {
    const { bank, all } = world();
    const t = setup(new Map([["alice", all]]), ON);
    await warm(t.partner, alice);
    bank.items = bank.items.filter((i) => i.ref !== REF);
    const a = await ask(t.partner, alice, "s1");
    expect(a.citations.map((c) => c.itemId)).not.toContain(itemId("bank", REF));
    expect(bank.fetches).toBe(1);
  });

  test("on: a cold item deleted at its source is dropped by the sweep, and never cited after", async () => {
    const { bank, all } = world();
    const t = setup(new Map([["alice", all]]), ON);
    await warm(t.partner, alice);
    bank.items = bank.items.filter((i) => i.ref !== REF);
    // Two sweeps miss it (one can skip an item): gone from the cold tier.
    await live(t, alice, 2.2);
    expect(t.partner.sync!.coldStats(alice).items).toBe(19);
    const a = await ask(t.partner, alice, "s1");
    expect(a.citations.map((c) => c.itemId)).not.toContain(itemId("bank", REF));
  });

  test("on: a cold item changed at its source is read again by the sweep", async () => {
    const { bank, all } = world();
    const t = setup(new Map([["alice", all]]), ON);
    await warm(t.partner, alice);
    const changed = { ...bank.items[ASKED]!, text: "isa allowance: 4,000 left this year" };
    bank.items = bank.items.map((i) => (i.ref === REF ? changed : i));
    await live(t, alice, 1.1);
    const a = await ask(t.partner, alice, "s1");
    expect(a.citations.map((c) => c.itemId)).toContain(itemId("bank", REF));
    expect(a.answer).toContain("4,000 left");
    expect(bank.searches).toBe(0);
  });

  test("on: past the cold tier's room the copy is cut and searched live, as before", async () => {
    const { bank, all } = world();
    const t = setup(new Map([["alice", all]]), { syncCold: true, syncColdMaxItems: 5 });
    await warm(t.partner, alice);
    expect(t.partner.sync!.coldStats(alice).items).toBe(5);
    expect(t.partner.sync!.complete(alice, "bank")).toBe(false);
    const a = await ask(t.partner, alice, "s1");
    expect(a.citations.map((c) => c.itemId)).toContain(itemId("bank", REF));
    expect(bank.searches).toBeGreaterThan(0);
  });

  test("on: one user's cold items never answer another's ask, and forget drops them", async () => {
    const a = world();
    const b = world();
    b.bank.items = b.bank.items.map((i) => (i.ref === REF ? { ...i, text: "card fees none" } : i));
    const t = setup(
      new Map([
        ["alice", a.all],
        ["bob", b.all],
      ]),
      ON,
    );
    await warm(t.partner, alice);
    await warm(t.partner, bob);
    const got = await ask(t.partner, bob, "s-bob");
    expect(got.answer).not.toContain("isa allowance statement");
    expect(t.partner.sync!.coldStats(bob).items).toBe(20);
    t.partner.forget(alice);
    expect(t.partner.sync!.coldStats(alice).items).toBe(0);
    expect(t.partner.sync!.coldStats(bob).items).toBe(20);
  });
});
