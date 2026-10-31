/**
 * The background economy (docs/research/econ-background.md): the cards' strict prefilter and sentence reuse
 * (`cardsEconomy`), the card maker's price routing and its retry of a cut batch, and push sync (`syncPush`), alone and
 * with `syncPollBehind`.
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, OpenRouterModel, type ChatRequest, type Model } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { DEFAULT_CACHE_LIMITS, ItemCache } from "./cache";
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

const NOW = Date.parse("2026-10-27T09:00:00Z");
const HOUR = 3_600_000;
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
    expect(DEFAULT_CONFIG.cardsEconomy).toBe(false);
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
        config: { cards: true, cardsEconomy: on },
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

// ── push sync ──

const T0 = Date.UTC(2026, 9, 20, 9);

class ListSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  lists = 0;
  items: ContextItem[];
  constructor(
    readonly id: string,
    n: number,
  ) {
    this.items = Array.from({ length: n }, (_, i) => this.make(`m${i}`, `Note ${i} about the plan`, T0 - i * HOUR));
  }
  make(ref: string, text: string, at: number): ContextItem {
    return { id: itemId(this.id, ref), sourceId: this.id, ref, title: ref, text, updatedAt: at };
  }
  async search(_q: SearchQuery): Promise<ContextItem[]> {
    return [];
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    this.lists++;
    const sorted = [...this.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
}

async function synced(config: Record<string, unknown>, users: Scope[] = [{ tenantId: "t", userId: "u" }], n = 4) {
  let clock = T0;
  const srcs = new Map<string, ListSource>();
  const cache = new ItemCache();
  const partner = new ContextPartner({
    sources: async (s) => {
      let x = srcs.get(s.userId);
      if (!x) srcs.set(s.userId, (x = new ListSource("mail", n)));
      return [x];
    },
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache,
    budget: new Budget(),
    model: null,
    now: () => clock,
    config: { sync: true, syncPageSize: 10, syncCallsPerMin: 600, ...config },
  });
  for (const u of users) partner.sync!.track(u, clock);
  for (let i = 0; i < 10 && !users.every((u) => partner.sync!.warm(u)); i++) await partner.sync!.tick();
  return { partner, cache, src: (u = "u") => srcs.get(u)!, advance: (ms: number) => (clock += ms), now: () => clock };
}

describe("push sync (syncPush)", () => {
  const scope: Scope = { tenantId: "t", userId: "u" };

  test("off by default: notices and watches are ignored", async () => {
    expect(DEFAULT_CONFIG.syncPush).toBe(false);
    const { partner, cache, now } = await synced({});
    const id = itemId("mail", "m1");
    const before = partner.sync!.current(scope, "mail", now());
    partner.sourcePushes(scope, "mail");
    partner.sourceChanged(scope, "mail");
    partner.sourceChanged(scope, "mail", { deleted: [id] });
    expect(partner.sync!.stats.notices).toBe(0);
    expect(partner.sync!.current(scope, "mail", now())).toBe(before);
    expect(cache.get(scope, id, now())).not.toBeNull();
  });

  test("a pushed source is current while quiet, stale on a notice, and current again after one poll", async () => {
    const { partner, src, advance, now, cache } = await synced({ syncPush: true });
    partner.sourcePushes(scope, "mail");
    advance(5 * HOUR);
    expect(partner.sync!.current(scope, "mail", now())).toBe(true);
    const before = src().lists;
    src().items.push(src().make("new", "Kestrel is frozen", now()));
    partner.sourceChanged(scope, "mail");
    expect(partner.sync!.current(scope, "mail", now())).toBe(false);
    advance(60_000);
    partner.sync!.track(scope, now());
    await partner.sync!.tick();
    expect(src().lists - before).toBe(1);
    expect(cache.get(scope, itemId("mail", "new"), now())).not.toBeNull();
    expect(partner.sync!.current(scope, "mail", now())).toBe(true);
    // A watch silent past syncPushMaxStaleMs is not trusted.
    advance(DEFAULT_CONFIG.syncPushMaxStaleMs + 1);
    expect(partner.sync!.current(scope, "mail", now())).toBe(false);
  });

  test("a quiet pushed source's items count as read now (confirmed); a notice or push off ends that", async () => {
    const { partner, advance, now } = await synced({ syncPush: true });
    expect(partner.sync!.confirmed(scope, "mail", now())).toBe(false); // No watch declared yet.
    partner.sourcePushes(scope, "mail");
    advance(5 * HOUR);
    expect(partner.sync!.confirmed(scope, "mail", now())).toBe(true);
    partner.sourceChanged(scope, "mail");
    expect(partner.sync!.confirmed(scope, "mail", now())).toBe(false);
    const off = await synced({});
    off.partner.sourcePushes(scope, "mail");
    expect(off.partner.sync!.confirmed(scope, "mail", off.now())).toBe(false);
  });

  test("a notice naming deleted items drops them at once, with no call", async () => {
    const { partner, src, cache, now } = await synced({ syncPush: true });
    partner.sourcePushes(scope, "mail");
    const id = itemId("mail", "m1");
    expect(cache.get(scope, id, now())).not.toBeNull();
    const before = src().lists;
    partner.sourceChanged(scope, "mail", { deleted: [id] });
    expect(cache.get(scope, id, now())).toBeNull();
    expect(src().lists).toBe(before);
    expect(partner.sync!.current(scope, "mail", now())).toBe(true);
  });

  test("a notice for one user never touches another's index or freshness", async () => {
    const a: Scope = { tenantId: "t", userId: "a" };
    const b: Scope = { tenantId: "t", userId: "b" };
    const { partner, cache, now } = await synced({ syncPush: true }, [a, b]);
    partner.sourcePushes(a, "mail");
    partner.sourcePushes(b, "mail");
    const id = itemId("mail", "m0");
    partner.sourceChanged(a, "mail", { deleted: [id] });
    partner.sourceChanged(a, "mail");
    expect(cache.get(a, id, now())).toBeNull();
    expect(cache.get(b, id, now())).not.toBeNull();
    expect(partner.sync!.current(a, "mail", now())).toBe(false);
    expect(partner.sync!.current(b, "mail", now())).toBe(true);
    // A notice for a user not synced starts nothing.
    partner.sourceChanged({ tenantId: "t", userId: "nobody" }, "mail");
    expect(partner.sync!.userCount).toBe(2);
  });

  test("a quiet pushed source's items never lapse from the cache between its sweeps", async () => {
    // Only sweeps re-list a quiet pushed source's older items, and a synced item lives `syncTtlMs` (7 days) from its
    // last listing. A sweep spans many ticks when the source is large and the rate is low, so a sweep every 7 days
    // let the first pages' items expire before the next sweep re-read them: lookups answered locally then missed them.
    const { partner, src, cache, advance, now } = await synced(
      { syncPush: true, syncPageSize: 2, syncCallsPerMin: 1 },
      [scope],
      40,
    );
    const step = async () => {
      advance(5 * 60_000);
      partner.sync!.track(scope, now());
      await partner.sync!.tick();
    };
    // The backfill, at one call a minute.
    while (!partner.sync!.warm(scope)) await step();
    partner.sourcePushes(scope, "mail");
    const ids = src().items.map((x) => x.id);
    let lapsed = 0;
    for (let t = 0; t < 8 * 24 * 12; t++) {
      await step();
      lapsed += ids.filter((id) => cache.get(scope, id, now()) === null).length;
    }
    expect(lapsed).toBe(0);
    expect(DEFAULT_CONFIG.syncPushSweepMs).toBeLessThanOrEqual(DEFAULT_CACHE_LIMITS.syncTtlMs / 2);
  });

  test("with a gap, a busy source's notices are read at most that often in the background", async () => {
    const { partner, src, advance, now } = await synced({ syncPush: true, syncPushGapMs: 30 * 60_000 });
    partner.sourcePushes(scope, "mail");
    const before = src().lists;
    for (let i = 0; i < 6; i++) {
      advance(5 * 60_000);
      src().items.push(src().make(`n${i}`, "news", now()));
      partner.sourceChanged(scope, "mail");
      partner.sync!.track(scope, now());
      await partner.sync!.tick();
    }
    // Thirty minutes of notices every five: at most two background polls (the backfill's poll began the gap).
    expect(src().lists - before).toBeLessThanOrEqual(2);
  });
});
