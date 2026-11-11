/**
 * Card state frozen with its user (D998, `CardEnricher.freeze`): a frozen-and-thawed enricher answers exactly as a
 * twin that never froze (cards, intent finds, requests, carded ids), through touches, forgotten items and sources,
 * more items and freezes again; nothing is frozen while work is queued or in flight; users stay apart; forget drops
 * a frozen user's state.
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { ContextItem, Scope } from "@eden/protocol";
import { ItemCache } from "./cache";
import { type Card, CardEnricher, type CardMaker } from "./cards";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

const NOW = Date.parse("2026-10-27T09:00:00Z");
const u1: Scope = { tenantId: "t", userId: "u1" };
const u2: Scope = { tenantId: "t", userId: "u2" };

/** A card for constraint wording, `none` otherwise; two requests an item, from its title. */
const maker: CardMaker = {
  async make(items, _today, _signal, _retry, intent) {
    const cards = items.map((it): Card =>
      /frozen|deadline|must/.test(it.text)
        ? {
            kind: "freeze",
            actions: ["deploy"],
            entities: [it.title.split(" ")[0]!],
            end: "2026-11-09",
            statement: `${it.title} holds`,
          }
        : { kind: "none", actions: [], entities: [], statement: "" },
    );
    const requests = intent ? items.map((it) => [`deploy ${it.title}`, `book the ${it.ref} review`]) : undefined;
    return { cards, ...(requests ? { requests } : {}), costUsd: 0 };
  },
};

const item = (n: number, source = "mail"): ContextItem => ({
  id: `${source}:m${n}`,
  sourceId: source,
  ref: `m${n}`,
  title: `Kestrel ${n % 7} cluster`,
  // Every third repeats an earlier one's words (sentence reuse); constraint wording on half.
  text:
    n % 2 === 0
      ? `The Kestrel ${n % 3 === 0 ? 1 : n} cluster is frozen until the deadline. Deploys must wait.`
      : `Notes from the ${n} standup about lunch and the offsite.`,
});

const enricher = () =>
  new CardEnricher({ maker, budget: new Budget(), now: () => NOW }, { intent: true, sentenceReuse: true });

/**
 * A user's whole card state, read from the enricher's insides (as `cache-freeze.test.ts` reads the cache's): every
 * map in its order, a shared hash's holders in theirs, the intent index's docs. Reading it thaws the user.
 */
function state(e: CardEnricher, scope: Scope) {
  e.carded(scope); // thaws
  const users = (e as unknown as { users: Map<string, Record<string, unknown>> }).users;
  const u = users.get(`${scope.tenantId}/${scope.userId}`)!;
  const holders = [...(u.holders as Map<string, string | Set<string>>)].map(([h, ids]) => [
    h,
    typeof ids === "string" ? [ids] : [...ids],
  ]);
  const intent = u.intent as { export(): unknown } | undefined;
  return {
    enlisted: u.enlisted,
    byHash: [...(u.byHash as Map<string, unknown>)],
    byItem: [...(u.byItem as Map<string, string>)],
    holders: holders.sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    bySentence: [...(u.bySentence as Map<string, string>)],
    intent: intent?.export(),
    calls: e.stats.calls,
  };
}

/** Everything a reader of the enricher sees for a user's items, in order. */
function view(e: CardEnricher, scope: Scope, ids: string[]) {
  const cards = [...e.cardsOf(scope, ids, NOW + 1)];
  const finds = ["deploy Kestrel 3", "book the review", "Kestrel cluster", "the m4 review"].map((q) =>
    e.intentFinds(scope, q, NOW + 1, 5, () => true),
  );
  const requests = ids.map((id) => e.requestsOf(scope, id, NOW + 1));
  return { cards, finds, requests, carded: e.carded(scope), intent: e.intentSize(scope) };
}

describe("card state frozen with its user (D998)", () => {
  test("a frozen and thawed user answers as a twin that never froze, through every change", async () => {
    const a = enricher();
    const b = enricher();
    const both = async (f: (e: CardEnricher) => void) => {
      f(a);
      f(b);
      await a.idle();
      await b.idle();
    };
    const ids = Array.from({ length: 80 }, (_, i) => item(i).id);
    await both((e) =>
      e.enqueue(
        u1,
        Array.from({ length: 60 }, (_, i) => item(i)),
      ),
    );
    expect(a.freeze(u1)).toBe(true);
    expect(a.frozenCount).toBe(1);
    expect(view(a, u1, ids)).toEqual(view(b, u1, ids));
    expect(a.frozenCount).toBe(0); // thawed by the read
    expect(state(a, u1)).toEqual(state(b, u1));

    expect(a.freeze(u1)).toBe(true);
    await both((e) => e.touch(u1, ids.slice(0, 10)));
    await both((e) => e.forgetItems(u1, ids.slice(10, 20)));
    expect(a.freeze(u1)).toBe(true);
    await both((e) =>
      e.enqueue(
        u1,
        Array.from({ length: 20 }, (_, i) => item(60 + i)),
      ),
    );
    expect(view(a, u1, ids)).toEqual(view(b, u1, ids));
    expect(state(a, u1)).toEqual(state(b, u1));

    expect(a.freeze(u1)).toBe(true);
    await both((e) => e.enqueue(u1, [item(100, "docs"), item(101, "docs"), item(4, "docs")]));
    expect(a.freeze(u1)).toBe(true);
    await both((e) => e.forget(u1, "docs"));
    const all = [...ids, "docs:m100", "docs:m101", "docs:m4"];
    expect(view(a, u1, all)).toEqual(view(b, u1, all));
    expect(state(a, u1)).toEqual(state(b, u1));
    const v = view(a, u1, all);
    expect(v.carded.length).toBeGreaterThan(10);
    expect(v.cards.length).toBeGreaterThan(10);
    expect(v.finds.every((f) => f.length > 0)).toBe(true);
    expect(v.requests.filter((r) => r.length > 0).length).toBeGreaterThan(30);
  });

  test("nothing freezes while the user's work is queued or in flight", async () => {
    const e = enricher();
    e.enqueue(u1, [item(2), item(4)]);
    expect(e.freeze(u1)).toBe(false);
    await e.idle();
    expect(e.freeze(u1)).toBe(true);
    expect(e.freeze(u2)).toBe(false); // no state at all
  });

  test("users stay apart, and forget drops a frozen user's state", async () => {
    const e = enricher();
    e.enqueue(u1, [item(2), item(4)]);
    e.enqueue(u2, [item(6)]);
    await e.idle();
    const before = view(e, u2, ["mail:m6", "mail:m2"]);
    expect(e.freeze(u1)).toBe(true);
    expect(view(e, u2, ["mail:m6", "mail:m2"])).toEqual(before);
    expect(e.frozenCount).toBe(1);
    e.forget(u1);
    expect(e.frozenCount).toBe(0);
    expect(e.userCount).toBe(1);
    expect(e.cardsOf(u1, ["mail:m2"], NOW + 1).size).toBe(0);
  });

  test("the partner freezes a user's cards when the cache freezes the user, and a read thaws them", async () => {
    const cache = new ItemCache({ freezeIdleMs: 2, warmIdleMs: 1, expireEveryMs: 1 });
    cache.close(); // the test runs the ticks
    const cards = enricher();
    new ContextPartner({
      sources: async () => [],
      sourceMap: new SourceMap(),
      cache,
      budget: new Budget(),
      model: null,
      now: () => NOW,
      config: { ...CORE_CONFIG, cards: true, intent: true },
      cards,
    });
    cache.put(u1, [item(2), item(4)], NOW, false, true, 1);
    cards.enqueue(u1, [item(2), item(4)]);
    await cards.idle();
    const want = cards.cardsOf(u1, ["mail:m2", "mail:m4"], NOW + 1);
    expect(want.size).toBe(2);
    for (let t = 0; t < 4 && cache.frozenCount === 0; t++) cache.expireIdle(NOW);
    expect(cache.frozenCount).toBe(1);
    expect(cards.frozenCount).toBe(1);
    // The cache's thaw of the user (a returning user's `ready`) thaws their cards with it, before any lookup reads them.
    await cache.ready(u1);
    expect(cache.frozenCount).toBe(0);
    expect(cards.frozenCount).toBe(0);
    expect(cards.cardsOf(u1, ["mail:m2", "mail:m4"], NOW + 1)).toEqual(want);
    // A read with the cache still frozen thaws them too.
    for (let t = 0; t < 4 && cache.frozenCount === 0; t++) cache.expireIdle(NOW);
    expect(cards.frozenCount).toBe(1);
    expect(cards.cardsOf(u1, ["mail:m2", "mail:m4"], NOW + 1)).toEqual(want);
    expect(cards.frozenCount).toBe(0);
  });
});
