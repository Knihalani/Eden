/**
 * `intentByKind` (D200, on in the default; docs/research/fix-s3a-intent.md): constraint-carded intent hits get their
 * own coverage floor and places past the `intentHits` cut.
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { CardEnricher, type Card, type CardMaker } from "./cards";
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

  test("intentCut reads the engine's keys; the default has it on (D200), the core off", () => {
    expect(DEFAULT_CONFIG.intentByKind).toBe(true);
    expect(intentCut(CORE_CONFIG).byKind).toBeNull();
    expect(intentCut({ ...DEFAULT_CONFIG, intentByKind: false }).byKind).toBeNull();
    const on = intentCut(DEFAULT_CONFIG);
    expect(on.byKind).toEqual({ cardCoverage: DEFAULT_CONFIG.intentCardCoverage, cardHits: 4 });
    expect(on.hits).toBe(DEFAULT_CONFIG.intentHits);
  });

  test("the config checker knows the keys and their parents", () => {
    const deps = { deps: { cards: true } };
    const on = { intentByKind: true, intentCardCoverage: 0.05, intentCardHits: 2 };
    expect(checkEngineConfig(on, deps)).toMatchObject(on);
    expect(() => checkEngineConfig({ intentCardCoverage: 1.5, intentByKind: true }, deps)).toThrow();
    // A child key with its parent switch off is refused.
    expect(() => checkEngineConfig({ intentByKind: false, intentCardHits: 2 }, deps)).toThrow();
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

/** A maker answering from tables by title. */
class TableMaker implements CardMaker {
  constructor(
    private readonly requests: Record<string, string[]>,
    private readonly cards: Record<string, Card> = {},
  ) {}
  async make(items: ContextItem[], _t: string, _s: AbortSignal, _r?: boolean, intent?: boolean) {
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
    const off = await run({ intentByKind: false });
    expect(off.pool).toContain(starter.id);
    expect(off.pool).not.toContain(frozen.id);
    const on = await run({ intentByKind: true, intentCardCoverage: 0 });
    expect(on.pool).toContain(frozen.id);
    expect(on.pool).not.toContain(plain.id);
  });
});
