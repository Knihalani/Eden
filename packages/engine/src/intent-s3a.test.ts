/**
 * The S3a trials (docs/research/fix-s3a-intent.md): `intentByKind` (D200, constraint-carded intent hits get their own
 * threshold and places past the cut) and `intentAgentPhrasing` (D201, the requests asked for in the wording an
 * agent's user delegates in). Both off by default.
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { CardEnricher, cardMessages, ModelCardMaker, type Card, type CardMaker, type IntentPrompt } from "./cards";
import { checkEngineConfig } from "./config-check";
import { DEFAULT_CONFIG } from "./config";
import { intentCut, intentReach, keepIntents, type IntentCut, type IntentRow } from "./intent";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { AskReader, type ReaderInput, type ReaderMaker } from "./reader";

const row = (id: string, coverage: number, carded = false, matched = 1): IntentRow => ({
  ids: [id],
  hit: { coverage, matched },
  carded,
});
const OFF: IntentCut = { hits: 3, minCoverage: 0.2, minMatched: 1, byKind: null };
const ON: IntentCut = { ...OFF, byKind: { cardCoverage: 0.1, cardHits: 2 } };

describe("keepIntents (intentByKind, D200)", () => {
  test("off: one threshold, the first `hits` raw hits, at most `hits` ids (the engine's loop before D200)", () => {
    const rows = [row("a", 0.5), row("b", 0.15, true), row("c", 0.3), row("d", 0.9), row("e", 0.9, true)];
    expect([...keepIntents(rows, OFF).keys()]).toEqual(["a", "c"]);
    expect(keepIntents(rows, OFF).get("c")).toEqual({ rank: 1, coverage: 0.3, matched: 1 });
    // `minMatched` still holds, whatever the coverage.
    expect(keepIntents([row("a", 0.9, false, 1)], { ...OFF, minMatched: 2 }).size).toBe(0);
    // Ids past `hits` are cut even inside the first raw hits.
    const wide: IntentRow = { ids: ["x", "y", "z", "w"], hit: { coverage: 0.9, matched: 3 } };
    expect([...keepIntents([wide], OFF).keys()]).toEqual(["x", "y", "z"]);
    expect(intentReach(OFF)).toBe(3);
  });

  test("on: a carded hit counts from `cardCoverage`; an uncarded one still needs `minCoverage`", () => {
    const rows = [row("a", 0.5), row("b", 0.15, true), row("u", 0.15), row("c", 0.05, true)];
    expect([...keepIntents(rows, ON).keys()]).toEqual(["a", "b"]);
  });

  test("on: carded hits past the cut take up to `cardHits` places after the others", () => {
    const rows = [row("a", 0.5), row("b", 0.5), row("c", 0.5), row("d", 0.5, true), row("e", 0.12, true)];
    rows.push(row("f", 0.4, true), row("g", 0.9)); // f is a third carded one past the cut; g is uncarded.
    const kept = keepIntents(rows, ON);
    expect([...kept.keys()]).toEqual(["a", "b", "c", "d", "e"]);
    expect(kept.get("e")!.rank).toBe(4);
    // Read 3x `hits` deep for them.
    expect(intentReach(ON)).toBe(9);
    expect(intentReach({ ...ON, byKind: { cardCoverage: 0.1, cardHits: 0 } })).toBe(3);
  });

  test("intentCut reads the engine's keys; the default has the trial off", () => {
    expect(DEFAULT_CONFIG.intentByKind).toBe(false);
    expect(intentCut(DEFAULT_CONFIG).byKind).toBeNull();
    const on = intentCut({ ...DEFAULT_CONFIG, intentByKind: true });
    expect(on.byKind).toEqual({ cardCoverage: DEFAULT_CONFIG.intentCardCoverage, cardHits: 4 });
    expect(on.hits).toBe(DEFAULT_CONFIG.intentHits);
  });

  test("the config checker knows the keys and their parents", () => {
    const deps = { deps: { cards: true } };
    const on = { intentByKind: true, intentCardCoverage: 0.05, intentCardHits: 2 };
    expect(checkEngineConfig(on, deps)).toMatchObject(on);
    expect(checkEngineConfig({ intentAgentPhrasing: true }, deps)).toMatchObject({ intentAgentPhrasing: true });
    expect(() => checkEngineConfig({ intentCardCoverage: 1.5, intentByKind: true }, deps)).toThrow();
    // A child key with its parent switch off is refused.
    expect(() => checkEngineConfig({ intentCardHits: 2 }, deps)).toThrow();
  });
});

/** Tuesday 27 October 2026, 09:00 UTC. */
const NOW = Date.parse("2026-10-27T09:00:00Z");
const HOUR = 3_600_000;
const item = (id: string, title: string, text: string): ContextItem => ({
  id: `chat:${id}`,
  sourceId: "chat",
  ref: id,
  title,
  text,
});
const NONE: Card = { kind: "none", actions: [], entities: [], statement: "" };
const FREEZE: Card = {
  kind: "freeze",
  // An action the request is not, so the card path (`cardFinds`) does not seat it on its own.
  actions: ["travel"],
  entities: ["hardware line"],
  statement: "no spending on the hardware line until December",
};

/** A maker answering from tables by title, recording what wording each call asked for. */
class TableMaker implements CardMaker {
  asked: (boolean | IntentPrompt | undefined)[] = [];
  constructor(
    private readonly requests: Record<string, string[]>,
    private readonly cards: Record<string, Card> = {},
  ) {}
  async make(items: ContextItem[], _t: string, _s: AbortSignal, _r?: boolean, intent?: boolean | IntentPrompt) {
    this.asked.push(intent);
    return {
      cards: items.map((i) => this.cards[i.title] ?? NONE),
      ...(intent ? { requests: items.map((i) => this.requests[i.title] ?? []) } : {}),
      costUsd: 0.001,
    };
  }
}

class PoolReader implements ReaderMaker {
  pools: string[][] = [];
  async read(input: ReaderInput) {
    this.pools.push(input.items.map((i) => i.id));
    return { bears: [], rejected: [], costUsd: 0 };
  }
}

describe("intentByKind in the partner: a carded weak hit reaches the reader's pool, an uncarded one does not", () => {
  // Both items' requests hold one word of the request ("laptop"), neither item's text does.
  const frozen = item("f", "Budget", "Finance: no more spending on the hardware line until December.");
  const plain = item("p", "Warranty", "Your cover renews on the 3rd; reply to keep it.");
  // Found by its words, so the ask has a lexical candidate (with none, it reads whatever the cache holds).
  const starter = item("s", "Starter", "Our new designer joins the London studio next week.");
  const REQUEST = "Order a laptop for the new designer joining in the London studio next week";
  const source: Source = {
    id: "chat",
    kind: "test",
    description: "Team chat",
    search: async (q) => (/budget|warranty/i.test(q.text) ? [frozen, plain, starter] : []),
  };

  const run = async (config: Record<string, unknown>) => {
    let clock = NOW;
    const maker = new TableMaker(
      // The starter's requests hold the request's other words: coverage is a share of the idf the index knows.
      {
        Budget: ["buy a laptop"],
        Warranty: ["renew the laptop cover"],
        Starter: ["welcome the new designer to the London studio next week"],
      },
      { Budget: FREEZE },
    );
    const cards = new CardEnricher({ maker, budget: new Budget(), now: () => clock });
    const reader = new PoolReader();
    const p = new ContextPartner({
      sources: async () => [source],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => clock,
      // A shared floor no one-word hit on this long request clears: only the carded floor can let one in.
      config: {
        ...CORE_CONFIG,
        cards: true,
        intent: true,
        askReader: true,
        askReaderWaitMs: 500,
        intentMinCoverage: 0.9,
        ...config,
      },
      cards,
      reader: new AskReader({ maker: reader, budget: new Budget(), now: () => clock }),
    });
    const scope = { tenantId: "t", userId: "u" };
    await p.observe(
      { ...scope, sessionId: "s1", at: clock, kind: "user_message", text: "Any news on the budget or warranty?" },
      { waitMs: 1_000 },
    );
    await cards.idle();
    clock += HOUR;
    const before = reader.pools.length;
    await p.ask({ ...scope, sessionId: "s2", question: REQUEST });
    const found = cards.intentFinds(scope, REQUEST, clock, 12, () => true);
    return { pool: reader.pools.slice(before).flat(), found };
  };

  test("the store says which hits are carded", async () => {
    const { found } = await run({});
    expect(found.find((f) => f.ids.includes(frozen.id))?.carded).toBe(true);
    expect(found.find((f) => f.ids.includes(plain.id))?.carded).toBe(false);
  });

  test("off: neither weak hit is a candidate; on: the carded one is, the uncarded one is not", async () => {
    const off = await run({});
    expect(off.pool).toContain(starter.id);
    expect(off.pool).not.toContain(frozen.id);
    const on = await run({ intentByKind: true, intentCardCoverage: 0 });
    expect(on.pool).toContain(frozen.id);
    expect(on.pool).not.toContain(plain.id);
  });
});

describe("intentAgentPhrasing (D201): the requests' wording", () => {
  const it1 = item("a", "Budget", "No hardware purchases until December.");

  test("the agent prompt asks for delegations and questions; the user prompt is unchanged", () => {
    const agent = cardMessages([it1], "2026-10-27", "agent")[0]!.content as string;
    const user = cardMessages([it1], "2026-10-27", true)[0]!.content as string;
    const none = cardMessages([it1], "2026-10-27")[0]!.content as string;
    expect(agent).toContain("personal assistant");
    expect(agent).toContain("imperative");
    expect(agent).toContain('"requests"');
    expect(user).toContain("in the user's everyday words, not the item's own");
    expect(user).not.toContain("imperative");
    expect(none).not.toContain('"requests"');
  });

  test("ModelCardMaker sends the agent prompt and reads its requests", async () => {
    const model = new FakeModel(() => JSON.stringify({ cards: [], requests: [{ i: 0, q: ["Order a laptop"] }] }));
    const got = await new ModelCardMaker(model).make([it1], "2026-10-27", new AbortController().signal, false, "agent");
    expect(got.requests).toEqual([["Order a laptop"]]);
    expect(JSON.stringify(model.calls[0])).toContain("imperative");
  });

  test("the enricher asks in the configured wording, and economy keeps it", async () => {
    for (const [prompt, want] of [
      ["user", true],
      ["agent", "agent"],
    ] as const) {
      const maker = new TableMaker({ Budget: ["buy a laptop"] });
      const cards = new CardEnricher({ maker, budget: new Budget(), now: () => NOW });
      cards.intend(prompt);
      cards.economize();
      cards.enqueue({ tenantId: "t", userId: "u" }, [it1]);
      await cards.idle();
      expect(maker.asked).toEqual([want]);
    }
  });

  test("the partner wires it: on, its card calls ask for agent wording; the default asks for the user's", async () => {
    for (const [on, want] of [
      [false, true],
      [true, "agent"],
    ] as const) {
      const maker = new TableMaker({ Budget: ["buy a laptop"] });
      const cards = new CardEnricher({ maker, budget: new Budget(), now: () => NOW });
      const source: Source = { id: "chat", kind: "test", description: "Team chat", search: async () => [it1] };
      const p = new ContextPartner({
        sources: async () => [source],
        sourceMap: new SourceMap(),
        cache: new ItemCache(),
        budget: new Budget(),
        model: null,
        now: () => NOW,
        config: { ...CORE_CONFIG, cards: true, intent: true, intentAgentPhrasing: on },
        cards,
      });
      const ev = { tenantId: "t", userId: "u", sessionId: "s", at: NOW, kind: "user_message", text: "budget news?" };
      await p.observe(ev as AgentEvent, { waitMs: 1_000 });
      await cards.idle();
      expect(maker.asked.length).toBeGreaterThan(0);
      expect(new Set(maker.asked)).toEqual(new Set([want]));
    }
  });
});
