import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { CardEnricher, type Card, type CardMaker } from "./cards";
import { IntentIndex, type IntentExpander } from "./intent";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

/** M11 (D970): the intent micro-expansion's wiring (`intentMicro`): modes, lifecycle, isolation, fail-open. */
const NOW = Date.parse("2026-10-27T09:00:00Z");
const HOUR = 3_600_000;
const item = (id: string, title: string, text: string, sourceId = "chat"): ContextItem => ({
  id: `${sourceId}:${id}`,
  sourceId,
  ref: id,
  title,
  text,
});
const NONE: Card = { kind: "none", actions: [], entities: [], statement: "" };

class IntentMaker implements CardMaker {
  calls: { n: number; intent: boolean }[] = [];
  constructor(private readonly requests: Record<string, string[]>) {}
  async make(items: ContextItem[], _today: string, _signal: AbortSignal, _retry?: boolean, intent?: boolean) {
    this.calls.push({ n: items.length, intent: intent === true });
    return {
      cards: items.map(() => NONE),
      ...(intent ? { requests: items.map((i) => this.requests[i.title] ?? []) } : {}),
      costUsd: 0.001,
    };
  }
}

/** An expander from a table by title: pre-stemmed terms, as the model gives them. */
const table = (t: Record<string, string[]>): IntentExpander & { calls: number } => {
  const e = {
    calls: 0,
    expand(title: string) {
      e.calls++;
      return t[title] ?? [];
    },
  };
  return e;
};

const scope = { tenantId: "t", userId: "u" };
const policy = item("p", "Finance policy", "Spend over £5,000 needs a second signature from Dana.");
const chat = item("c", "Catching up", "Fancy drinks next week?");
const EXP = { "Finance policy": ["approv", "laptop", "laptop", "order"], "Catching up": ["drink", "plan"] };
const find = (e: CardEnricher, s: typeof scope, text: string, at = NOW + 1) =>
  e.intentFinds(s, text, at, 5, () => true).map((f) => f.ids);

describe("the enricher with the micro expansion (intentMicro)", () => {
  test("mode 1: every item is expanded at enqueue, the calls write no requests and rejects are not read", async () => {
    const maker = new IntentMaker({ "Finance policy": ["pay the invoice"] });
    const e = new CardEnricher({ maker, budget: new Budget(), now: () => NOW });
    const x = table(EXP);
    e.micro(1, x);
    e.enqueue(scope, [policy, chat]);
    // Indexed before any call: an item is findable from its ingest.
    expect(e.intentSize(scope)).toBe(2);
    await e.idle();
    expect(maker.calls).toEqual([{ n: 1, intent: false }]);
    expect(find(e, scope, "Approve the laptop order")).toEqual([[policy.id]]);
    expect(find(e, scope, "plan drinks")).toEqual([[chat.id]]);
    // Made at NOW: an earlier request does not see it.
    expect(find(e, scope, "Approve the laptop order", NOW)).toEqual([]);
    // Once a content: the same item again is not expanded again.
    e.enqueue(scope, [policy]);
    expect(x.calls).toBe(2);
    expect(e.stats.expanded).toBe(2);
  });

  test("mode 2: the calls' requests stand where made; the expansion only where they gave none", async () => {
    const maker = new IntentMaker({ "Finance policy": ["pay the invoice"] });
    const e = new CardEnricher({ maker, budget: new Budget(), now: () => NOW });
    e.intend();
    e.micro(2, table(EXP));
    e.enqueue(scope, [policy, chat]);
    await e.idle();
    expect(find(e, scope, "pay the invoice")).toEqual([[policy.id]]);
    expect(find(e, scope, "Approve the laptop order")).toEqual([]);
    expect(find(e, scope, "plan drinks")).toEqual([[chat.id]]);
  });

  test("mode 1 ignores requests a call writes anyway (a replay, an intended enricher)", async () => {
    const e = new CardEnricher({
      maker: new IntentMaker({ "Finance policy": ["pay the invoice"] }),
      budget: new Budget(),
      now: () => NOW,
    });
    e.intend();
    e.micro(1, table(EXP));
    e.enqueue(scope, [policy]);
    await e.idle();
    expect(find(e, scope, "pay the invoice")).toEqual([]);
    expect(find(e, scope, "Approve the laptop order")).toEqual([[policy.id]]);
  });

  test("isolated per user and tenant; dropped with the item, its source and the user", async () => {
    const e = new CardEnricher({ maker: new IntentMaker({}), budget: new Budget(), now: () => NOW });
    e.micro(1, table(EXP));
    const other = { tenantId: "t", userId: "v" };
    const otherTenant = { tenantId: "t2", userId: "u" };
    e.enqueue(scope, [policy]);
    await e.idle();
    expect(find(e, scope, "laptop order")).toEqual([[policy.id]]);
    expect(find(e, other, "laptop order")).toEqual([]);
    expect(find(e, otherTenant, "laptop order")).toEqual([]);
    e.forgetItems(scope, [policy.id]);
    expect(find(e, scope, "laptop order")).toEqual([]);
    expect(e.intentSize(scope)).toBe(0);
    e.enqueue(scope, [policy]);
    await e.idle();
    e.forget(scope, "chat");
    expect(find(e, scope, "laptop order")).toEqual([]);
    e.enqueue(scope, [policy]);
    e.enqueue(other, [policy]);
    await e.idle();
    e.forget(scope);
    expect(find(e, scope, "laptop order")).toEqual([]);
    expect(find(e, other, "laptop order")).toEqual([[policy.id]]);
  });

  test("fails open: an expander that throws leaves the item unexpanded and its card still made", async () => {
    const maker = new IntentMaker({});
    const e = new CardEnricher({ maker, budget: new Budget(), now: () => NOW });
    e.micro(1, {
      expand() {
        throw new Error("broken weights");
      },
    });
    e.enqueue(scope, [policy]);
    await e.idle();
    expect(e.intentSize(scope)).toBe(0);
    expect(maker.calls.length).toBe(1);
  });

  test("a card evicted for room leaves the expansion of a still-held item indexed", async () => {
    const e = new CardEnricher(
      { maker: new IntentMaker({}), budget: new Budget(), now: () => NOW },
      { maxCardsPerUser: 1 },
    );
    e.micro(1, table(EXP));
    const policy2 = item("p2", "Finance policy", "Spend over £9,000 needs a third signature.");
    e.enqueue(scope, [policy, policy2]);
    await e.idle();
    expect(find(e, scope, "laptop order").flat().sort()).toEqual([policy.id, policy2.id].sort());
  });

  test("the expansion's text is redacted before it is indexed", async () => {
    const key = "sk-ant-api03-" + "a".repeat(40);
    const e = new CardEnricher({ maker: new IntentMaker({}), budget: new Budget(), now: () => NOW });
    e.micro(1, table({ "Finance policy": ["laptop", key] }));
    e.enqueue(scope, [policy]);
    expect(find(e, scope, key)).toEqual([]);
    expect(find(e, scope, "laptop")).toEqual([[policy.id]]);
  });
});

describe("IntentIndex.setTerms", () => {
  test("pre-stemmed terms are indexed as given; non-terms are dropped; requests cannot pose as terms", () => {
    const ix = new IntentIndex();
    // "summaris" would stem again to "summari" through `intentTerms`: as given, a request's stem meets it.
    ix.setTerms("a", ["summaris", "not a term", "", "x".repeat(60)]);
    expect(ix.search("summarise the notes", 5).map((h) => h.hash)).toEqual(["a"]);
    // A request starting with the marker is stemmed as any request ("summari"), never taken as terms.
    ix.set("b", ["\u0000summaris"]);
    expect(ix.search("summarise", 5).map((h) => h.hash)).toEqual(["a"]);
    expect(ix.search("summari", 5).map((h) => h.hash)).toEqual(["b"]);
    ix.setTerms("a", []);
    expect(ix.size).toBe(1);
  });
});

describe("intentMicro in the engine", () => {
  const anySource = (items: ContextItem[]): Source => ({
    id: "chat",
    kind: "test",
    description: "Team chat",
    search: async (q) => {
      const words = q.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
      return items.filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)));
    },
  });
  const REQUEST = "Approve the laptop order for the design team";
  const run = async (config: Record<string, unknown>, expander?: IntentExpander) => {
    let clock = NOW;
    const maker = new IntentMaker({});
    const cards = new CardEnricher({ maker, budget: new Budget(), now: () => clock });
    const p = new ContextPartner({
      sources: async () => [anySource([policy])],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => clock,
      config: { ...CORE_CONFIG, cards: true, intent: true, ...config },
      cards,
      ...(expander ? { intentExpander: expander } : {}),
    });
    await p.observe(
      {
        ...scope,
        sessionId: "s1",
        at: clock,
        kind: "user_message",
        text: "Any news on the finance policy?",
      } as AgentEvent,
      { waitMs: 1_000 },
    );
    await cards.idle();
    clock += HOUR;
    const a = await p.ask({ ...scope, sessionId: "s3", question: REQUEST });
    return { asked: a.citations.map((c) => c.itemId), maker };
  };

  test("an ask finds an item sharing no word with it by its expansion; off or unwired, it does not", async () => {
    const on = await run({ intentMicro: 1 }, table(EXP));
    expect(on.asked).toEqual([policy.id]);
    expect(on.maker.calls.every((c) => !c.intent)).toBe(true);
    expect((await run({ intentMicro: 0 }, table(EXP))).asked).toEqual([]);
    expect((await run({ intentMicro: 1 })).asked).toEqual([]);
  });
});
