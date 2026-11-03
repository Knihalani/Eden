/**
 * The background economy (docs/research/econ-background.md): the cards' strict prefilter and sentence reuse
 * (`cardsEconomy`), and the card maker's price routing and its retry of a cut batch.
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, OpenRouterModel, type ChatRequest, type Model } from "@eden/llm";
import type { ContextItem, Scope } from "@eden/protocol";
import { ItemCache } from "./cache";
import {
  CardEnricher,
  cardMessages,
  ModelCardMaker,
  parseCards,
  sentenceKey,
  worthCarding,
  worthCardingStrict,
  type Card,
  type CardMaker,
} from "./cards";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

const NOW = Date.parse("2026-10-27T09:00:00Z");
const item = (id: string, title: string, text: string, sourceId = "mail"): ContextItem => ({
  id: `${sourceId}:${id}`,
  sourceId,
  ref: id,
  title,
  text,
});
const DISCLAIMER =
  "CONFIDENTIALITY NOTICE: This email and any attachments are confidential and may be legally privileged. If you " +
  "are not the intended recipient, please notify the sender and delete it.";
const POLICY = "Reminder that travel over £500 needs pre-approval from now on.";
const policyCard: Card = {
  kind: "dependency",
  actions: ["travel"],
  entities: ["travel"],
  limit: 500,
  unit: "£",
  statement: "travel over £500 needs pre-approval",
};

/** A maker that cards every item whose text holds the policy sentence, counting the items it is sent. */
class PolicyMaker implements CardMaker {
  sent: number[] = [];
  async make(items: ContextItem[]) {
    this.sent.push(items.length);
    const none: Card = { kind: "none", actions: [], entities: [], statement: "" };
    return { cards: items.map((i) => (i.text.includes("pre-approval") ? policyCard : none)), costUsd: 0.0002 };
  }
}

describe("the strict prefilter (cardsEconomy)", () => {
  test("a legal footer or a notification footer alone is not a constraint", () => {
    const intro = item(
      "i1",
      "Intro",
      `Hi Robin, introducing you two, good partnership angle. Cheers, Zoe ${DISCLAIMER}`,
    );
    expect(worthCarding(intro)).toBe(true); // D59's prefilter reads the footer's "confidential".
    expect(worthCardingStrict(intro)).toBe(false);
    const pr = item(
      "n1",
      "PR 12: fix flaky test",
      "Merged into main. To change what you receive, visit your notification preferences. Please do not reply.",
    );
    expect(worthCardingStrict(pr)).toBe(false);
  });

  test("a reply's subject is the thread's: its own words decide", () => {
    const reply = item("r1", "Re: Expense policy", "Thanks, will review. Shout if you have any questions.");
    expect(worthCarding(reply)).toBe(true);
    expect(worthCardingStrict(reply)).toBe(false);
    // The thread's first message keeps its subject, and a reply that says a constraint still passes.
    expect(worthCardingStrict(item("p1", "Expense policy", "Hi Robin, quick one."))).toBe(true);
    expect(worthCardingStrict(item("r2", "Re: Lunch?", "Sorry, I'm away until Monday."))).toBe(true);
  });

  test("a constraint before the footer still passes", () => {
    const freeze = item("f1", "Ops", `Production is frozen from 4 to 9 November. ${DISCLAIMER}`);
    expect(worthCardingStrict(freeze)).toBe(true);
  });

  test("the cut ends with the footer's block: a constraint after a disclaimer still passes", () => {
    // A PS, or a message forwarded below a sender's disclaimer: the footer's paragraph is cut, not the rest.
    const ps = item("f2", "Lunch", `Hi Robin, lunch at 1?\n\n${DISCLAIMER}\n\nPS: production is frozen 4-9 November.`);
    expect(worthCardingStrict(ps)).toBe(true);
    expect(sentenceKey(ps)).toBeDefined();
    // The footer's block alone, and two footer blocks in a row, are still cut.
    const two = item("f3", "Lunch", `Hi Robin, lunch at 1?\n\n${DISCLAIMER}\n\nManage your notification settings.`);
    expect(worthCardingStrict(two)).toBe(false);
    // Lines of one block (no blank line between) belong to the footer.
    const lines = item("f4", "Lunch", `Hi Robin, lunch at 1?\n${DISCLAIMER}\nUnauthorised copying is prohibited.`);
    expect(worthCardingStrict(lines)).toBe(false);
  });
});

describe("sentence keys (cardsEconomy)", () => {
  test("the same constraint in other greetings has one key; another constraint has another", () => {
    const a = item("a", "Expense policy", `Hi Robin, ${POLICY} Thanks! Mateo`);
    const b = item("b", "Expense policy", `Morning Robin, following up. ${POLICY} Kind regards, Rose ${DISCLAIMER}`);
    const c = item("c", "Expense policy", "Hi Robin, travel over £900 needs pre-approval from now on.");
    expect(sentenceKey(a)).toBeDefined();
    expect(sentenceKey(a)).toBe(sentenceKey(b));
    expect(sentenceKey(c)).not.toBe(sentenceKey(a));
  });

  test("a sentence dated relative to its message has no key (the same words name other days)", () => {
    expect(sentenceKey(item("t", "Standup", "Standup is cancelled tomorrow."))).toBeUndefined();
    expect(sentenceKey(item("n", "Hi", "Lovely to see you."))).toBeUndefined();
  });
});

describe("the enricher's economy preset", () => {
  const scope: Scope = { tenantId: "t", userId: "u" };

  test("off by default: D59's prefilter, batches of ten, one call per content", async () => {
    const maker = new PolicyMaker();
    const e = new CardEnricher({ maker, budget: new Budget(), now: () => NOW });
    const items = Array.from({ length: 12 }, (_, n) => item(`p${n}`, "Expense policy", `Hi ${n}, ${POLICY}`));
    e.enqueue(scope, [...items, item("i", "Intro", `Hello. ${DISCLAIMER}`)]);
    await e.idle();
    expect(maker.sent).toEqual([10, 3]);
    expect(e.stats.sentenceReused).toBe(0);
  });

  test("on: the footer-only item is not sent, and items saying the same constraint share one card", async () => {
    const maker = new PolicyMaker();
    const e = new CardEnricher({ maker, budget: new Budget(), now: () => NOW });
    e.economize();
    const items = Array.from({ length: 12 }, (_, n) => item(`p${n}`, "Expense policy", `Hi ${n}, ${POLICY}`));
    e.enqueue(scope, [...items, item("i", "Intro", `Hello. ${DISCLAIMER}`)]);
    await e.idle();
    expect(maker.sent).toEqual([1]);
    expect(e.stats.sentenceReused).toBe(11);
    const cards = e.cardsOf(
      scope,
      items.map((i) => i.id),
      NOW + 1,
    );
    expect(cards.size).toBe(12);
    // Later arrivals take the card with no call.
    e.enqueue(scope, [item("p99", "Expense policy", `Morning, ${POLICY}`)]);
    await e.idle();
    expect(maker.sent).toEqual([1]);
    expect(e.cardsOf(scope, ["mail:p99"], NOW + 1).size).toBe(1);
  });

  test("users are isolated: one user's card is never another's, and forget drops the user", async () => {
    const maker = new PolicyMaker();
    const e = new CardEnricher({ maker, budget: new Budget(), now: () => NOW });
    e.economize();
    const a: Scope = { tenantId: "t", userId: "a" };
    const b: Scope = { tenantId: "t", userId: "b" };
    e.enqueue(a, [item("x", "Expense policy", `Hi, ${POLICY}`)]);
    await e.idle();
    e.enqueue(b, [item("y", "Expense policy", `Hello, ${POLICY}`)]);
    await e.idle();
    // b's item went to the model: a's card is not b's to reuse.
    expect(maker.sent).toEqual([1, 1]);
    expect(e.cardsOf(b, ["mail:x"], NOW + 1).size).toBe(0);
    e.forget(a);
    expect(e.cardsOf(a, ["mail:x"], NOW + 1).size).toBe(0);
    expect(e.cardsOf(b, ["mail:y"], NOW + 1).size).toBe(1);
  });

  test("a reused card goes with its own item; the item it was read from leaving does not take it", async () => {
    const maker = new PolicyMaker();
    const e = new CardEnricher({ maker, budget: new Budget(), now: () => NOW });
    e.economize();
    e.enqueue(scope, [item("x", "Expense policy", `Hi, ${POLICY}`), item("y", "Expense policy", `Yo, ${POLICY}`)]);
    await e.idle();
    e.forgetItems(scope, ["mail:x"]);
    expect(e.cardsOf(scope, ["mail:x"], NOW + 1).size).toBe(0);
    expect(e.cardsOf(scope, ["mail:y"], NOW + 1).size).toBe(1);
    e.forgetItems(scope, ["mail:y"]);
    expect(e.cardsOf(scope, ["mail:y"], NOW + 1).size).toBe(0);
  });

  test("a limit given at construction wins over the preset", async () => {
    const maker = new PolicyMaker();
    const e = new CardEnricher({ maker, budget: new Budget(), now: () => NOW }, { sentenceReuse: false });
    e.economize();
    e.enqueue(scope, [item("x", "Expense policy", `Hi, ${POLICY}`), item("y", "Expense policy", `Yo, ${POLICY}`)]);
    await e.idle();
    expect(maker.sent).toEqual([2]);
  });

  test("the partner applies the preset only with cardsEconomy", () => {
    // On in the default (D112), out in the core these tests start from.
    expect(DEFAULT_CONFIG.cardsEconomy).toBe(true);
    expect(CORE_CONFIG.cardsEconomy).toBe(false);
    for (const on of [false, true]) {
      const cards = new CardEnricher({ maker: new PolicyMaker(), budget: new Budget(), now: () => NOW });
      let economized = false;
      cards.economize = () => void (economized = true);
      new ContextPartner({
        sources: async () => [],
        sourceMap: new SourceMap(":memory:", { seed: 1 }),
        cache: new ItemCache(),
        budget: new Budget(),
        model: null,
        cards,
        config: { ...CORE_CONFIG, cards: true, cardsEconomy: on },
      });
      expect(economized).toBe(on);
    }
  });
});

describe("the card maker and its routing", () => {
  /** A model that records each request and answers with `text` (no cards by default), cut off when `truncated`. */
  const recorder = (text = '{"cards":[]}', truncated = false) => {
    const seen: ChatRequest[] = [];
    const model: Model = {
      id: "m",
      chat: async (r) => {
        seen.push(r);
        return {
          text,
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          costUsd: 0.0001,
          model: "m",
          latencyMs: 1,
          truncated,
        };
      },
    };
    return { seen, model };
  };

  test("D59's call: low reasoning, the 2,000-token cap, today in the system prompt", async () => {
    const { seen, model } = recorder();
    await new ModelCardMaker(model).make([item("a", "Ops", "Frozen.")], "2026-10-27", AbortSignal.timeout(1_000));
    expect(seen[0]).toMatchObject({ reasoning: "low", maxTokens: 2_000 });
    expect(seen[0]!.messages[0]!.content).toContain("Today is 2026-10-27");
    expect(cardMessages([item("a", "Ops", "Frozen.")], "2026-10-27")).toEqual(seen[0]!.messages);
  });

  test("the cap grows with a batch past ten (200 tokens an item)", async () => {
    const { seen, model } = recorder();
    const twenty = Array.from({ length: 20 }, (_, n) => item(`a${n}`, "Ops", "Frozen."));
    await new ModelCardMaker(model).make(twenty, "2026-10-27", AbortSignal.timeout(1_000));
    expect(seen[0]!.maxTokens).toBe(4_000);
  });

  test("a retry goes to the retry model, and a call cut off at the cap says so", async () => {
    const cut = recorder('{"cards":[{"i":0,"kind":"freeze"', true);
    const plain = recorder();
    const maker = new ModelCardMaker(cut.model, { retry: plain.model });
    const first = await maker.make([item("a", "Ops", "Frozen.")], "2026-10-27", AbortSignal.timeout(1_000));
    expect(first).toMatchObject({ cards: [null], truncated: true });
    const again = await maker.make([item("a", "Ops", "Frozen.")], "2026-10-27", AbortSignal.timeout(1_000), true);
    expect(again.truncated).toBe(false);
    expect([cut.seen.length, plain.seen.length]).toEqual([1, 1]);
    // With no retry model, a retry goes to the same one.
    const alone = recorder();
    await new ModelCardMaker(alone.model).make([item("a", "Ops", "x")], "2026-10-27", AbortSignal.timeout(1_000), true);
    expect(alone.seen.length).toBe(1);
  });
});

describe("a card batch cut off at the cap (price routing)", () => {
  const scope: Scope = { tenantId: "t", userId: "u" };
  const freeze = (n: number) => item(`f${n}`, "Ops", `Production change freeze on service ${n} from 4 to 9 November.`);
  const freezeCard = (n: number) => ({
    i: n,
    kind: "freeze",
    actions: ["deploy"],
    entities: [`service ${n}`],
    start: "2026-11-04",
    end: "2026-11-09",
    statement: `production change freeze service ${n}`,
  });

  /** The price-routed call is cut off (unreadable JSON); the default-routed retry reads the whole batch. */
  class CutMaker implements CardMaker {
    calls: boolean[] = [];
    constructor(private readonly retryCuts = false) {}
    async make(items: ContextItem[], _today: string, _signal: AbortSignal, retry = false) {
      this.calls.push(retry);
      if (!retry || this.retryCuts) return { cards: items.map(() => null), costUsd: 0.0001, truncated: true };
      const text = JSON.stringify({ cards: items.map((_, n) => freezeCard(n)) });
      return { cards: parseCards(text, items.length), costUsd: 0.0002, truncated: false };
    }
  }

  test("is sent once more with default routing, under its own reservation, and its items are covered", async () => {
    const maker = new CutMaker();
    const budget = new Budget();
    const e = new CardEnricher({ maker, budget, now: () => NOW });
    const items = [freeze(1), freeze(2), freeze(3)];
    e.enqueue(scope, items);
    await e.idle();
    expect(maker.calls).toEqual([false, true]);
    expect(e.stats).toMatchObject({ calls: 2, retries: 1, sent: 6 });
    expect(e.stats.costUsd).toBeCloseTo(0.0003, 8);
    expect(
      e.cardsOf(
        scope,
        items.map((i) => i.id),
        NOW + 1,
      ).size,
    ).toBe(3);
  });

  test("a retry that is cut off too is not sent a third time: its items stay uncovered", async () => {
    const maker = new CutMaker(true);
    const e = new CardEnricher({ maker, budget: new Budget(), now: () => NOW });
    e.enqueue(scope, [freeze(1)]);
    await e.idle();
    expect(maker.calls).toEqual([false, true]);
    expect(e.cardsOf(scope, ["mail:f1"], NOW + 1).size).toBe(0);
  });

  test("over the user's budget, the retry is not made and the cut call's result stands", async () => {
    const maker = new CutMaker();
    // Room for one reserved call only.
    const budget = new Budget({ usdPerUserDay: 0.002, usdPerSession: Infinity, callsPerSession: Infinity });
    const e = new CardEnricher({ maker, budget, now: () => NOW });
    e.enqueue(scope, [freeze(1)]);
    await e.idle();
    expect(maker.calls).toEqual([false]);
    expect(e.stats.retries).toBe(0);
    expect(e.cardsOf(scope, ["mail:f1"], NOW + 1).size).toBe(0);
  });
});

describe("OpenRouter routing", () => {
  test("sort is sent only when set, beside the no-retention preferences; the serving endpoint is reported", async () => {
    const sent: any[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return Response.json({ provider: "Cheap", choices: [{ message: { content: "{}" } }], usage: { cost: 0.00001 } });
    }) as unknown as typeof fetch;
    const plain = new OpenRouterModel({ apiKey: "k", model: "z-ai/glm-5.3-flash", fetch: fake });
    const cheap = new OpenRouterModel({ apiKey: "k", model: "z-ai/glm-5.3-flash", fetch: fake, sort: "price" });
    await plain.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 10 });
    const out = await cheap.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 10 });
    expect(sent[0].provider.sort).toBeUndefined();
    expect(sent[1].provider).toEqual({ data_collection: "deny", zdr: true, allow_fallbacks: true, sort: "price" });
    expect(out.provider).toBe("Cheap");
  });
});
