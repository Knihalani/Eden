import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { CardEnricher, cardVerdict, plausible, type Card, type CardMaker } from "./cards";
import type { Frame } from "./conflict";
import { ContextPartner } from "./partner";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-10-27T09:00:00Z");
const scope = { tenantId: "t1", userId: "u1" };

test("a card with one open end holds for at most a year past its other end", () => {
  const card: Card = {
    kind: "freeze",
    actions: ["deploy"],
    entities: ["production"],
    start: "2026-10-27",
    statement: "production freeze",
  };
  expect(plausible(card, "2026-10-27")).toBe(true);
  const frame = {
    days: ["2028-06-01"],
    named: true,
    amounts: [],
    refs: [],
    routine: false,
    names: [],
    nameTies: new Set<string>(),
    wordTies: new Set<string>(),
  } as Frame;
  // Over 580 days after the card's start: past the year an open end may reach.
  expect(cardVerdict(card, frame, new Set(["deploy"]))?.violated).toBe(false);
  // Within the year, the open-ended freeze still holds.
  expect(cardVerdict(card, { ...frame, days: ["2026-12-01"] }, new Set(["deploy"]))?.violated).toBe(true);
});

class ListSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  constructor(
    readonly id: string,
    public items: ContextItem[],
  ) {}
  async search(_q: SearchQuery): Promise<ContextItem[]> {
    return [];
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    const at = cursor ? Number(cursor) : 0;
    return {
      items: this.items.slice(at, at + limit),
      next: at + limit < this.items.length ? String(at + limit) : null,
    };
  }
}

test("a synced item still held and unchanged after 8 days keeps its card", async () => {
  let clock = T0;
  const leave: ContextItem = {
    id: itemId("mail", "1"),
    sourceId: "mail",
    ref: "1",
    title: "Leave",
    text: "Priya is on medical leave until 20 Nov, do not contact her about the Acme deal.",
    updatedAt: T0 - HOUR,
  };
  const src = new ListSource("mail", [leave]);
  let calls = 0;
  const maker: CardMaker = {
    make: async (items) => {
      calls++;
      return {
        costUsd: 0,
        cards: items.map((): Card => ({
          kind: "absence",
          actions: ["contact"],
          entities: ["Priya"],
          statement: "Priya on medical leave",
        })),
      };
    },
  };
  const cards = new CardEnricher({ maker, budget: new Budget(), now: () => clock });
  const cache = new ItemCache();
  const p = new ContextPartner({
    sources: async () => [src],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache,
    budget: new Budget(),
    model: null,
    now: () => clock,
    cards,
    config: { sync: true, cards: true, syncPageSize: 10, syncCallsPerMin: 6000, syncSweepMs: DAY },
  });
  const sync = p.sync!;
  sync.track(scope);
  for (let i = 0; i < 20 && !sync.warm(scope); i++) {
    clock += 60_000;
    await sync.tick();
  }
  await cards.idle();
  expect(cards.cardsOf(scope, [leave.id], Infinity).size).toBe(1);
  for (let h = 0; h < 8 * 24; h++) {
    clock += HOUR;
    sync.track(scope);
    await sync.tick();
  }
  await cards.idle();
  expect(cache.get(scope, leave.id, clock)).not.toBeNull(); // Still held: re-listed by every sweep.
  const after = cards.cardsOf(scope, [leave.id], Infinity).size;
  expect(after).toBe(1);
  expect(calls).toBe(1); // Kept alive by being listed, not remade.
});

test("an item evicted by the same put that brought it is not returned, so it gets no card", async () => {
  const maker: CardMaker = {
    make: async (items) => ({
      costUsd: 0,
      cards: items.map((): Card => ({
        kind: "absence",
        actions: ["contact"],
        entities: ["Priya"],
        statement: "Priya",
      })),
    }),
  };
  const cards = new CardEnricher({ maker, budget: new Budget(), now: () => T0 });
  const cache = new ItemCache({ maxItemsPerUser: 1 });
  cache.onDropped((s, ids) => (ids ? cards.forgetItems(s, ids) : cards.forget(s)));
  const mk = (r: string): ContextItem => ({
    id: itemId("mail", r),
    sourceId: "mail",
    ref: r,
    title: `Leave ${r}`,
    text: `Priya is on leave, do not contact her (${r}).`,
  });
  const added = cache.put(scope, [mk("a"), mk("b")], T0); // As partner.store: put, then enqueue what it returned.
  cards.enqueue(scope, added);
  await cards.idle();
  expect(cache.get(scope, mk("a").id, T0)).toBeNull();
  expect(cards.carded(scope)).not.toContain(mk("a").id);
});

test('weak words are matched after stemming: "applies" anchors nothing', async () => {
  const { anchored } = await import("./cards");
  const item: ContextItem = {
    id: "mail:w",
    sourceId: "mail",
    ref: "w",
    title: "Note",
    text: "This policy applies to your account.",
  };
  const card: Card = { kind: "freeze", actions: ["deploy"], entities: [], statement: "freeze applies" };
  expect(anchored(card, item)).toBe(false);
});
