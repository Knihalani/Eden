/**
 * A13's scale switches (docs/research/a13-scale.md): a user with many sources. `cardsSourceAware` (D320) reads with
 * the card model only items of sources the user's lookups use, or that name the user's people; `syncKeepCut` (D321)
 * keeps a user's sync to its cap after the backfill and stops a sweep once it has listed every id it holds.
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { CardEnricher, type Card, type CardMaker } from "./cards";
import { sketchTerms, termHashes, TermSketch } from "./sketch";
import { CORE_CONFIG } from "./parts";
import { ContextPartner } from "./partner";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 9);
const alice = { tenantId: "t1", userId: "alice" };
const bob = { tenantId: "t1", userId: "bob" };
const NONE: Card = { kind: "none", actions: [], entities: [], statement: "" };

/** A newest-first listing source that counts its calls; its items can be replaced. */
class ListSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  lists = 0;
  constructor(
    readonly id: string,
    public items: ContextItem[],
  ) {}
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
}

const item = (src: string, i: number, text: string, hoursOld: number): ContextItem => ({
  id: itemId(src, `i${i}`),
  sourceId: src,
  ref: `i${i}`,
  title: `${src} note ${i}`,
  text,
  updatedAt: T0 - hoursOld * HOUR,
});

/** `n` sources of `per` items each; the first is "bank" (items about an ISA allowance), the rest filler. */
function sources(n: number, per: number, prefix = ""): ListSource[] {
  return Array.from({ length: n }, (_, k) => {
    const id = k === 0 ? `${prefix}bank` : `${prefix}src${k}`;
    return new ListSource(
      id,
      Array.from({ length: per }, (_, i) =>
        item(id, i, k === 0 ? `isa allowance statement ${i}` : `filler words sprint ${k} ${i}`, k + n * i),
      ),
    );
  });
}

class Maker implements CardMaker {
  read: string[] = [];
  async make(items: ContextItem[], _today: string, _signal: AbortSignal, _retry?: boolean, intent?: boolean) {
    for (const i of items) this.read.push(i.id);
    return { cards: items.map(() => NONE), ...(intent ? { requests: items.map(() => []) } : {}), costUsd: 0 };
  }
}

function setup(byUser: Map<string, Source[]>, config: Record<string, unknown>) {
  let clock = T0;
  const maker = new Maker();
  const cards = new CardEnricher({ maker, budget: new Budget(), now: () => clock });
  cards.intend();
  const cache = new ItemCache();
  const partner = new ContextPartner({
    sources: async (scope) => byUser.get(scope.userId) ?? [],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache,
    budget: new Budget(),
    model: null,
    cards,
    now: () => clock,
    config: {
      ...CORE_CONFIG,
      sync: true,
      syncOnDemand: true,
      cards: true,
      intent: true,
      syncPageSize: 10,
      syncCallsPerMin: 6_000,
      routeLocalHits: true,
      ...config,
    },
  });
  return { partner, cards, maker, cache, advance: (ms: number) => (clock += ms) };
}

async function warm(partner: ContextPartner, scope: Scope): Promise<void> {
  partner.sync!.track(scope);
  for (let i = 0; i < 200 && !partner.sync!.warm(scope); i++) await partner.sync!.tick();
  expect(partner.sync!.warm(scope)).toBe(true);
}

describe("cardsSourceAware (D320)", () => {
  test("past 32 sources, items of sources no lookup used wait; a lookup's sources are then read", async () => {
    const mine = sources(40, 3);
    const { partner, cards, maker } = setup(new Map([["alice", mine]]), { cardsSourceAware: true });
    await warm(partner, alice);
    await cards.idle();
    expect(maker.read).toHaveLength(0);
    expect(cards.stats.deferred).toBeGreaterThan(0);
    await partner.ask({ ...alice, sessionId: "s1", question: "Have I used my isa allowance?" });
    await cards.idle();
    // The ask searched the bank (its words match): its held items are read now; the filler sources' are not.
    expect(maker.read.some((id) => id.startsWith("bank"))).toBe(true);
    const searched = new Set(maker.read.map((id) => id.split(":")[0]));
    expect(searched.size).toBeLessThan(10);
  });

  test("an item naming a person the user's requests named is read", async () => {
    const mine = sources(40, 3);
    mine[5]!.items.push(item("src5", 9, "Dana Whitfield asked about the sprint", 0.5));
    const { partner, cards, maker } = setup(new Map([["alice", mine]]), { cardsSourceAware: true });
    partner.sync!.track(alice);
    partner.sync!.notePeople(alice, ["dana whitfield"]);
    await warm(partner, alice);
    await cards.idle();
    expect(maker.read).toContain(itemId("src5", "i9"));
  });

  test("off, or with 32 sources or fewer, every synced item is read as before", async () => {
    for (const [n, on] of [
      [40, false],
      [32, true],
    ] as const) {
      const { partner, cards, maker } = setup(new Map([["alice", sources(n, 2)]]), { cardsSourceAware: on });
      await warm(partner, alice);
      await cards.idle();
      expect(cards.stats.deferred).toBe(0);
      expect(maker.read.length).toBe(n * 2);
    }
  });

  test("one user's lookups do not make another's sources read (isolation)", async () => {
    const { partner, cards, maker } = setup(
      new Map([
        ["alice", sources(40, 2)],
        ["bob", sources(40, 2, "b-")],
      ]),
      { cardsSourceAware: true },
    );
    await warm(partner, alice);
    await warm(partner, bob);
    await partner.ask({ ...alice, sessionId: "s1", question: "Have I used my isa allowance?" });
    await cards.idle();
    expect(partner.sync!.engaged(alice, "bank")).toBe(true);
    expect(partner.sync!.engaged(bob, "b-bank")).toBe(false);
    partner.sync!.notePeople(alice, ["dana whitfield"]);
    expect(partner.sync!.peopleOf(bob).size).toBe(0);
    // Alice's bank was read; none of bob's items were.
    expect(maker.read.some((id) => id.startsWith("bank"))).toBe(true);
    expect(maker.read.some((id) => id.startsWith("b-"))).toBe(false);
    partner.forget(alice);
    expect(partner.sync!.peopleOf(alice).size).toBe(0);
  });
});

describe("syncKeepCut (D321)", () => {
  test("a sweep stops once it has listed every id the source holds", async () => {
    // One busy source of 60 items and 20 small ones; the cap keeps 30, so the busy one holds its newest few.
    const busy = new ListSource(
      "busy",
      Array.from({ length: 60 }, (_, i) => item("busy", i, `busy item ${i}`, 1 + 2 * i)),
    );
    const run = async (on: boolean) => {
      busy.lists = 0;
      const small = sources(21, 2).slice(1);
      const { partner, advance } = setup(new Map([["alice", [busy, ...small]]]), {
        syncMaxItems: 30,
        syncKeepCut: on,
      });
      await warm(partner, alice);
      const held = partner.sync!.syncedIds(alice, "busy").length;
      const before = busy.lists;
      advance(25 * HOUR);
      partner.sync!.track(alice);
      await partner.sync!.tick();
      return { held, sweep: busy.lists - before };
    };
    const off = await run(false);
    const on = await run(true);
    expect(on.held).toBeLessThanOrEqual(10);
    expect(on.held).toBe(off.held);
    expect(on.sweep).toBe(1);
    expect(off.sweep).toBeGreaterThan(on.sweep);
  });

  /**
   * One source, "old", whose items are all older than the user's cut, and ten others. "old" is listed first, so the
   * backfill's trim drops what it read of it: the user's sync holds none of it.
   */
  const withOld = () => [
    new ListSource(
      "old",
      [0, 1, 2].map((i) => item("old", i, `an old note ${i}`, 10_000 + i)),
    ),
    ...sources(10, 6),
  ];

  test("a sweep stores nothing older than the user's cut", async () => {
    const mine = withOld();
    const { partner, cache, advance } = setup(new Map([["alice", mine]]), { syncMaxItems: 20, syncKeepCut: true });
    await warm(partner, alice);
    expect(partner.sync!.syncedIds(alice, "old")).toHaveLength(0);
    advance(25 * HOUR);
    partner.sync!.track(alice);
    await partner.sync!.tick();
    expect(cache.isSynced(alice, itemId("old", "i0"))).toBe(false);
    expect(partner.sync!.complete(alice, "old")).toBe(false);
  });

  test("off, the same sweep stores the source's old items past the cap (the old behaviour)", async () => {
    const mine = withOld();
    const { partner, cache, advance } = setup(new Map([["alice", mine]]), { syncMaxItems: 20 });
    await warm(partner, alice);
    expect(partner.sync!.syncedIds(alice, "old")).toHaveLength(0);
    advance(25 * HOUR);
    partner.sync!.track(alice);
    await partner.sync!.tick();
    expect(cache.isSynced(alice, itemId("old", "i0"))).toBe(true);
  });
});

describe("TermSketch (D322)", () => {
  test("a folded sketch still holds every term added, and few others", () => {
    const sk = new TermSketch();
    const terms = Array.from({ length: 300 }, (_, i) => `term${String.fromCharCode(97 + (i % 26))}${i}`);
    for (const t of terms) sk.add(...termHashes(t));
    expect(sk.bytes).toBe(4096);
    sk.fold();
    expect(sk.bytes).toBeLessThan(1024);
    for (const t of terms) expect(sk.has(...termHashes(t))).toBe(true);
    let false_ = 0;
    for (let i = 0; i < 2_000; i++) if (sk.has(...termHashes(`other${i}x`))) false_++;
    expect(false_ / 2_000).toBeLessThan(0.06);
  });

  test("sketchTerms keeps words, not numbers, ids or stopwords", () => {
    expect(sketchTerms("The ISA allowance for 2026: deploy-123 and the ab")).toEqual(["isa", "allowance", "deploy"]);
  });
});

describe("routeSketch (D322)", () => {
  test("a source whose sketch holds the request's rare words is routed first, its items trimmed or not", async () => {
    // 40 sources; the cap keeps 20 items, so the bank (whose items are the oldest) holds none of its own.
    const mine = sources(40, 3);
    mine[0]!.items = mine[0]!.items.map((i) => ({ ...i, updatedAt: T0 - 5_000 * HOUR }));
    const routed = async (on: boolean) => {
      const { partner } = setup(new Map([["alice", mine]]), { syncMaxItems: 20, routeSketch: on });
      await warm(partner, alice);
      expect(partner.sync!.syncedIds(alice, "bank")).toHaveLength(0);
      const scores = partner.sync!.sketchScores(alice, sketchTerms("isa allowance").map(termHashes));
      return scores;
    };
    expect(await routed(false)).toBeUndefined();
    const on = await routed(true);
    expect([...on!.keys()]).toEqual(["bank"]);
  });

  test("sketches are per user (isolation)", async () => {
    const { partner } = setup(
      new Map([
        ["alice", sources(5, 2)],
        ["bob", sources(5, 2).slice(1)],
      ]),
      { routeSketch: true },
    );
    await warm(partner, alice);
    await warm(partner, bob);
    const q = sketchTerms("isa allowance").map(termHashes);
    expect(partner.sync!.sketchScores(alice, q)?.has("bank")).toBe(true);
    expect(partner.sync!.sketchScores(bob, q)).toBeUndefined();
  });
});

describe("syncEngagedDeep (D323)", () => {
  test("a cut source a lookup used is read whole again and answers from the index", async () => {
    // The bank's 12 items are the oldest; the cap (30) keeps the newest of 40 sources, so the bank's copy is cut.
    const mine = sources(40, 3);
    mine[0]!.items = Array.from({ length: 12 }, (_, i) => item("bank", i, `isa allowance statement ${i}`, 900 + i));
    const { partner, cache } = setup(new Map([["alice", mine]]), {
      syncMaxItems: 30,
      syncEngagedDeep: true,
    });
    await warm(partner, alice);
    expect(partner.sync!.complete(alice, "bank")).toBe(false);
    partner.sync!.engage(alice, ["bank"]);
    for (let i = 0; i < 5; i++) await partner.sync!.tick();
    expect(partner.sync!.complete(alice, "bank")).toBe(true);
    expect(mine[0]!.items.every((i) => cache.isSynced(alice, i.id))).toBe(true);
    // The trim keeps the bank's items first: the user's sync is back under its cap with all 12 held.
    let total = 0;
    for (const s of mine) total += partner.sync!.syncedIds(alice, s.id).length;
    expect(total).toBeLessThanOrEqual(30 + 10);
  });

  test("off, engaging a cut source reads nothing more", async () => {
    const mine = sources(40, 3);
    mine[0]!.items = Array.from({ length: 12 }, (_, i) => item("bank", i, `isa allowance statement ${i}`, 900 + i));
    const { partner } = setup(new Map([["alice", mine]]), { syncMaxItems: 30 });
    await warm(partner, alice);
    const before = mine[0]!.lists;
    partner.sync!.engage(alice, ["bank"]);
    for (let i = 0; i < 5; i++) await partner.sync!.tick();
    expect(mine[0]!.lists).toBe(before);
    expect(partner.sync!.complete(alice, "bank")).toBe(false);
  });

  test("one user's engagement deepens only their copy (isolation)", async () => {
    const make = () => {
      const m = sources(40, 3);
      m[0]!.items = Array.from({ length: 12 }, (_, i) => item("bank", i, `isa allowance statement ${i}`, 900 + i));
      return m;
    };
    const a = make();
    const b = make();
    const { partner } = setup(
      new Map([
        ["alice", a],
        ["bob", b],
      ]),
      { syncMaxItems: 30, syncEngagedDeep: true },
    );
    await warm(partner, alice);
    await warm(partner, bob);
    partner.sync!.engage(alice, ["bank"]);
    for (let i = 0; i < 5; i++) await partner.sync!.tick();
    expect(partner.sync!.complete(alice, "bank")).toBe(true);
    expect(partner.sync!.complete(bob, "bank")).toBe(false);
  });
});

describe("review regressions (A13)", () => {
  test("used sources keep at most half the cap: other sources' new items are still stored", async () => {
    // Two used sources of 20 items each, a cap of 30: before, they took the whole cap and the cut went to Infinity.
    const mine = sources(40, 3);
    mine[0]!.items = Array.from({ length: 20 }, (_, i) => item("bank", i, `isa allowance statement ${i}`, 900 + i));
    mine[1]!.items = Array.from({ length: 20 }, (_, i) => item("src1", i, `pension letter ${i}`, 950 + i));
    const { partner, cache, advance } = setup(new Map([["alice", mine]]), {
      syncMaxItems: 30,
      syncEngagedDeep: true,
      syncKeepCut: true,
    });
    await warm(partner, alice);
    partner.sync!.engage(alice, ["bank", "src1"]);
    for (let i = 0; i < 10; i++) await partner.sync!.tick();
    // A new newest item in an unused source: the daily sweep stores it.
    mine[7]!.items.push(item("src7", 99, "a fresh filler note", 0.1));
    advance(25 * HOUR);
    partner.sync!.track(alice);
    await partner.sync!.tick();
    expect(cache.isSynced(alice, itemId("src7", "i99"))).toBe(true);
  });

  test("items deferred past 32 sources are read when their source is used, even after the count fell", async () => {
    const all = sources(40, 3);
    const byUser = new Map([["alice", all as Source[]]]);
    const { partner, cards, maker } = setup(byUser, { cardsSourceAware: true });
    await warm(partner, alice);
    await cards.idle();
    expect(cards.stats.deferred).toBeGreaterThan(0);
    byUser.set("alice", all.slice(0, 30));
    await partner.sync!.tick();
    await partner.ask({ ...alice, sessionId: "s1", question: "Have I used my isa allowance?" });
    await cards.idle();
    expect(maker.read.some((id) => id.startsWith("bank"))).toBe(true);
  });

  test("a user's used sources are the 64 most recently used", async () => {
    const { partner } = setup(new Map([["alice", sources(100, 1)]]), {});
    await warm(partner, alice);
    partner.sync!.engage(
      alice,
      Array.from({ length: 70 }, (_, k) => `src${k + 1}`),
    );
    expect(partner.sync!.engaged(alice, "src1")).toBe(false);
    expect(partner.sync!.engaged(alice, "src6")).toBe(false);
    expect(partner.sync!.engaged(alice, "src7")).toBe(true);
    // Used again, it is the most recent: the next ones out are others.
    partner.sync!.engage(alice, ["src7", "bank"]);
    expect(partner.sync!.engaged(alice, "src7")).toBe(true);
    expect(partner.sync!.engaged(alice, "src8")).toBe(false);
  });

  test("a saturated sketch starts again rather than match every term", () => {
    const sk = new TermSketch();
    for (let i = 0; i < 40; i++) sk.add(...termHashes(`seed${i}`));
    sk.fold();
    for (let i = 0; i < 2_000; i++) sk.add(...termHashes(`more${i}x`));
    let false_ = 0;
    for (let i = 0; i < 1_000; i++) if (sk.has(...termHashes(`unseen${i}y`))) false_++;
    expect(false_ / 1_000).toBeLessThan(0.1);
  });

  test("a source used while its backfill ran ends whole: kept first, read to its end", async () => {
    // The bank's 20 items interleave with the others' by age, so the cap (30) cuts it; it lists 10 a page.
    const mine = sources(40, 3);
    mine[0]!.items = Array.from({ length: 20 }, (_, i) => item("bank", i, `isa allowance statement ${i}`, 2 * i + 0.5));
    // One listing a source a tick (a burst of one): the backfill spans ticks.
    const { partner, advance } = setup(new Map([["alice", mine]]), {
      syncMaxItems: 30,
      syncEngagedDeep: true,
      syncCallsPerMin: 3,
    });
    partner.sync!.track(alice);
    await partner.sync!.tick();
    expect(partner.sync!.isWarm(alice, "bank")).toBe(false);
    partner.sync!.engage(alice, ["bank"]);
    for (let i = 0; i < 60 && !partner.sync!.complete(alice, "bank"); i++) {
      advance(60_000);
      partner.sync!.track(alice);
      await partner.sync!.tick();
    }
    expect(partner.sync!.complete(alice, "bank")).toBe(true);
  });
});
