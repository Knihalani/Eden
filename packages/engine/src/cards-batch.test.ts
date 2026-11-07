/**
 * The CL3 trials on the card enricher: `cardsBatch` (D242), a backlog sent whole to a bulk maker, and `intentRequests`
 * (D243), fewer requests asked for and kept per item.
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel } from "@eden/llm";
import type { ContextItem } from "@eden/protocol";
import { ItemCache } from "./cache";
import { CardEnricher, cardMessages, ModelCardMaker, type Card, type CardMaker } from "./cards";
import { checkEngineConfig } from "./config-check";
import { MAX_REQUESTS } from "./intent";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

const NOW = Date.parse("2026-10-27T09:00:00Z");
const NONE: Card = { kind: "none", actions: [], entities: [], statement: "" };
const item = (id: string, title: string, text: string): ContextItem => ({
  id: `chat:${id}`,
  sourceId: "chat",
  ref: id,
  title,
  text,
});
const frozen = (n: number) => item(`f${n}`, `Ops ${n}`, `Kestrel ${n} is frozen from 4 to 9 November.`);
const freeze = (n: number): Card => ({
  kind: "freeze",
  actions: ["deploy"],
  entities: [],
  statement: `Kestrel ${n} frozen`,
  start: "2026-11-04",
  end: "2026-11-09",
});

/** Records each call's size, its intent argument and how many calls were in flight at once; answers after a tick. */
class Recorder implements CardMaker {
  calls: { n: number; intent: boolean | number | undefined }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  constructor(
    private readonly cardOf: (it: ContextItem) => Card = (it) => freeze(Number(it.title.split(" ")[1])),
    private readonly requests: string[] = [],
    private readonly fail = false,
  ) {}
  async make(items: ContextItem[], _t: string, _s: AbortSignal, _r?: boolean, intent?: boolean | number) {
    this.calls.push({ n: items.length, intent });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((r) => setTimeout(r, 2));
    this.inFlight--;
    if (this.fail) throw new Error("batch API down");
    return {
      cards: items.map((it) => this.cardOf(it)),
      ...(intent ? { requests: items.map(() => this.requests) } : {}),
      costUsd: 0.001,
    };
  }
}

const scope = { tenantId: "t", userId: "u" };

describe("cardsBatch (D242): a backlog goes to the bulk maker whole", () => {
  test("a queue of bulkFrom items or more is sent to the bulk maker, every batch at once; a trickle stays live", async () => {
    const live = new Recorder();
    const bulk = new Recorder();
    const e = new CardEnricher({ maker: live, bulk, budget: new Budget(), now: () => NOW });
    e.bulk(20);
    e.enqueue(
      scope,
      Array.from({ length: 25 }, (_, n) => frozen(n)),
    );
    await e.idle();
    expect(live.calls).toEqual([]);
    expect(bulk.calls.map((c) => c.n)).toEqual([10, 10, 5]);
    expect(bulk.maxInFlight).toBe(3);
    expect(e.cardsOf(scope, ["chat:f0", "chat:f24"], NOW + 1).size).toBe(2);
    // New items arriving later, under the threshold: live, one batch at a time.
    e.enqueue(
      scope,
      Array.from({ length: 3 }, (_, n) => frozen(25 + n)),
    );
    await e.idle();
    expect(live.calls.map((c) => c.n)).toEqual([3]);
    expect(e.stats.calls).toBe(4);
  });

  test("without a bulk maker, or with the switch off, every batch is live", async () => {
    for (const [withBulk, on] of [
      [false, true],
      [true, false],
    ] as const) {
      const live = new Recorder();
      const bulk = new Recorder();
      const e = new CardEnricher({ maker: live, ...(withBulk ? { bulk } : {}), budget: new Budget(), now: () => NOW });
      if (on) e.bulk(5);
      e.enqueue(
        scope,
        Array.from({ length: 12 }, (_, n) => frozen(n)),
      );
      await e.idle();
      expect(live.calls.map((c) => c.n)).toEqual([10, 2]);
      expect(live.maxInFlight).toBe(1);
      expect(bulk.calls).toEqual([]);
    }
  });

  test("a failed bulk call leaves its items uncovered and never throws; the rest of the round lands", async () => {
    let n = 0;
    const flaky: CardMaker = {
      make: async (items) => {
        if (n++ === 0) throw new Error("expired");
        return { cards: items.map((it) => freeze(Number(it.title.split(" ")[1]))), costUsd: 0.001 };
      },
    };
    const e = new CardEnricher({ maker: new Recorder(), bulk: flaky, budget: new Budget(), now: () => NOW });
    e.bulk(2);
    e.enqueue(
      scope,
      Array.from({ length: 20 }, (_, k) => frozen(k)),
    );
    await e.idle();
    expect(e.stats.failures).toBe(1);
    expect(e.cardsOf(scope, ["chat:f0"], NOW + 1).size).toBe(0);
    expect(e.cardsOf(scope, ["chat:f10"], NOW + 1).size).toBe(1);
  });

  test("over the user's budget the round stops: what waits is uncovered, counted, and nothing more is sent", async () => {
    const bulk = new Recorder();
    // Two reservations of 0.002 fit a $0.005 user-day; the third does not.
    const budget = new Budget({ callsPerSession: 1_000, usdPerSession: 1, usdPerUserDay: 0.005 });
    const e = new CardEnricher({ maker: new Recorder(), bulk, budget, now: () => NOW });
    e.bulk(2);
    e.enqueue(
      scope,
      Array.from({ length: 40 }, (_, k) => frozen(k)),
    );
    await e.idle();
    expect(bulk.calls.length).toBe(2);
    expect(e.stats.overBudget).toBe(20);
  });

  test("two items saying one constraint in one round: one is read, the other takes its card after the round", async () => {
    const bulk = new Recorder((it) =>
      it.title.startsWith("Ops") ? freeze(Number(it.title.split(" ")[1])) : freeze(0),
    );
    const e = new CardEnricher({ maker: new Recorder(), bulk, budget: new Budget(), now: () => NOW });
    e.economize();
    e.bulk(2);
    // Batches of twenty with the economy preset: the twin is item 25, in the second batch of the round.
    const twin = item("twin", "Re: Ops 0", "Kestrel 0 is frozen from 4 to 9 November.");
    const items = Array.from({ length: 25 }, (_, k) => frozen(k));
    e.enqueue(scope, [...items, twin]);
    await e.idle();
    const sent = bulk.calls.reduce((a, c) => a + c.n, 0);
    expect(sent).toBe(25);
    expect(e.stats.sentenceReused).toBeGreaterThanOrEqual(1);
    expect(e.cardsOf(scope, [twin.id], NOW + 1).size).toBe(1);
  });

  test("users stay apart: each user's backlog goes in its own round, its cards its own", async () => {
    const bulk = new Recorder();
    const e = new CardEnricher({ maker: new Recorder(), bulk, budget: new Budget(), now: () => NOW });
    e.bulk(5);
    const a = { tenantId: "t", userId: "a" };
    const b = { tenantId: "t2", userId: "a" };
    e.enqueue(
      a,
      Array.from({ length: 6 }, (_, k) => frozen(k)),
    );
    e.enqueue(b, [frozen(100)]);
    await e.idle();
    expect(e.cardsOf(a, ["chat:f0"], NOW + 1).size).toBe(1);
    expect(e.cardsOf(b, ["chat:f0"], NOW + 1).size).toBe(0);
    expect(e.cardsOf(b, ["chat:f100"], NOW + 1).size).toBe(1);
    // b's single item was under the threshold: live, not bulk.
    expect(bulk.calls.map((c) => c.n)).toEqual([6]);
  });

  test("the partner turns it on from the configuration (cardsBatch, cardsBatchFrom)", async () => {
    const live = new Recorder();
    const bulk = new Recorder();
    const cards = new CardEnricher({ maker: live, bulk, budget: new Budget(), now: () => NOW });
    new ContextPartner({
      sources: async () => [],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => NOW,
      config: { ...CORE_CONFIG, cards: true, cardsBatch: true, cardsBatchFrom: 3 },
      cards,
    });
    cards.enqueue(
      scope,
      Array.from({ length: 4 }, (_, k) => frozen(k)),
    );
    await cards.idle();
    expect(bulk.calls.map((c) => c.n)).toEqual([4]);
    expect(live.calls).toEqual([]);
    const deps = { deps: { cards: true } };
    expect(() => checkEngineConfig({ cards: true, cardsBatch: true, cardsBatchFrom: 0 }, deps)).toThrow(
      "cardsBatchFrom",
    );
    expect(() => checkEngineConfig({ cards: true, cardsBatchFrom: 10 }, deps)).toThrow("cardsBatch");
  });
});

describe("intentRequests (D243): fewer requests asked for and kept", () => {
  const chat = item("c", "Catching up", "Fancy drinks next week?");

  test("the maker is asked for the cap, and requests beyond it are cut", async () => {
    const maker = new Recorder(() => NONE, ["plan drinks", "book a bar", "invite Sam", "move my Friday"]);
    const e = new CardEnricher({ maker, budget: new Budget(), now: () => NOW });
    e.intend();
    e.requests(2);
    e.enqueue(scope, [chat]);
    await e.idle();
    expect(maker.calls).toEqual([{ n: 1, intent: 2 }]);
    // "move my Friday" was the fourth: cut, so it finds nothing.
    expect(e.intentFinds(scope, "book a bar", NOW + 1, 5, () => true).length).toBe(1);
    expect(e.intentFinds(scope, "move my Friday", NOW + 1, 5, () => true).length).toBe(0);
  });

  test("at the default (four) the maker gets `true` and the prompt is the measured one", async () => {
    const maker = new Recorder(() => NONE, ["a b"]);
    const e = new CardEnricher({ maker, budget: new Budget(), now: () => NOW });
    e.intend();
    e.requests(MAX_REQUESTS);
    e.enqueue(scope, [chat]);
    await e.idle();
    expect(maker.calls).toEqual([{ n: 1, intent: true }]);
    const asTrue = cardMessages([chat], "2026-10-27", true)[0]!.content;
    expect(cardMessages([chat], "2026-10-27", MAX_REQUESTS)[0]!.content).toBe(asTrue);
    expect(asTrue).toContain("write up to 4 short requests or questions the user");
    const two = cardMessages([chat], "2026-10-27", 2)[0]!.content;
    expect(two).toContain("up to 2 short requests or questions (eight words at most each)");
  });

  test("ModelCardMaker sends the capped prompt and parses its requests", async () => {
    const model = new FakeModel((r) => {
      expect(r.messages[0]!.content).toContain("up to 1 short requests");
      return JSON.stringify({ cards: [], requests: [{ i: 0, q: ["plan drinks"] }] });
    });
    const got = await new ModelCardMaker(model).make([chat], "2026-10-27", new AbortController().signal, false, 1);
    expect(got.requests).toEqual([["plan drinks"]]);
  });

  test("the setting is checked: 1 to 4, whole", () => {
    const deps = { deps: { cards: true } };
    expect(() => checkEngineConfig({ intentRequests: 0 }, deps)).toThrow("at least 1");
    expect(() => checkEngineConfig({ intentRequests: 5 }, deps)).toThrow("intentRequests");
    expect(() => checkEngineConfig({ intentRequests: 2.5 }, deps)).toThrow("intentRequests");
    expect(checkEngineConfig({ intentRequests: 2 }, deps)).toEqual({ intentRequests: 2 });
  });
});
