/**
 * `cardsKeepOnly` (F5, trial; docs/research/f5-rule-sheet.md §4): an item the prefilter rejects but reads for its
 * requests keeps the card the same call wrote for it, instead of `none`. No extra call.
 */
import { describe, expect, test } from "bun:test";
import { Budget } from "@eden/llm";
import type { ContextItem } from "@eden/protocol";
import { CardEnricher, worthCarding, type Card, type CardMaker } from "./cards";
import { checkEngineConfig } from "./config-check";
import { DEFAULT_CONFIG } from "./config";

const NOW = Date.parse("2026-10-27T09:00:00Z");
// No deontic or status word: the prefilter rejects it, so it is read for its requests only.
const LIFT: ContextItem = {
  id: "chat:lift",
  sourceId: "chat",
  ref: "lift",
  title: "Residents",
  text: "Goods lift is out of service this week, engineers back Monday.",
  updatedAt: NOW - 3_600_000,
};
const CARD: Card = {
  kind: "absence",
  actions: ["attend"],
  entities: ["goods lift"],
  statement: "the goods lift is out of service this week",
};

class OneCard implements CardMaker {
  calls = 0;
  async make(items: ContextItem[], _t: string, _s: AbortSignal, _r?: boolean, intent?: boolean) {
    this.calls++;
    return {
      cards: items.map(() => CARD),
      ...(intent ? { requests: items.map(() => ["have the sofa delivered"]) } : {}),
      costUsd: 0.001,
    };
  }
}

async function cardOf(keep: boolean): Promise<{ card: Card | undefined; calls: number }> {
  const maker = new OneCard();
  const cards = new CardEnricher({ maker, budget: new Budget(), now: () => NOW });
  cards.intend();
  if (keep) cards.keepOnly();
  const scope = { tenantId: "t", userId: "u" };
  cards.enqueue(scope, [LIFT]);
  await cards.idle();
  return { card: cards.cardsOf(scope, [LIFT.id], NOW + 1).get(LIFT.id), calls: maker.calls };
}

describe("cardsKeepOnly (F5)", () => {
  test("off in the default; a request-only read keeps none, whatever the model wrote", async () => {
    expect(DEFAULT_CONFIG.cardsKeepOnly).toBe(false);
    expect(worthCarding(LIFT)).toBe(false);
    const off = await cardOf(false);
    expect(off.card).toBeUndefined();
    expect(off.calls).toBe(1);
  });

  test("on: the same call's card is kept, with no extra call", async () => {
    const on = await cardOf(true);
    expect(on.card?.kind).toBe("absence");
    expect(on.calls).toBe(1);
  });

  test("the config checker knows it: it needs cards and intent", () => {
    expect(checkEngineConfig({ cardsKeepOnly: true }, { deps: { cards: true } })).toEqual({ cardsKeepOnly: true });
    expect(() => checkEngineConfig({ cardsKeepOnly: true, intent: false }, { deps: { cards: true } })).toThrow();
  });
});
