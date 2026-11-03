/**
 * Regressions from the review of the background economy (D66): sentence reuse's key, retention and over-budget count.
 */
import { describe, expect, test } from "bun:test";
import { Budget } from "@eden/llm";
import type { ContextItem, Scope } from "@eden/protocol";
import { CardEnricher, sentenceKey, type Card, type CardMaker } from "./cards";

const T0 = Date.UTC(2026, 9, 20, 9);
const scope: Scope = { tenantId: "t", userId: "u" };

const BODY = "Do not share the deck externally.";
const mail = (ref: string, title: string, text = BODY): ContextItem => ({
  id: `mail:${ref}`,
  sourceId: "mail",
  ref,
  title,
  text,
});

/** Cards whose entity is the first word of the item's title, as a model reading the title would write. */
class TitleMaker implements CardMaker {
  sent: number[] = [];
  async make(items: ContextItem[]) {
    this.sent.push(items.length);
    return {
      cards: items.map((i): Card => ({
        kind: "prohibition",
        actions: ["share-external"],
        entities: [i.title.replace(/^re:\s*/i, "").split(" ")[0]!],
        statement: `${i.title}: do not share`,
      })),
      costUsd: 0,
    };
  }
}

describe("sentence reuse (cardsEconomy)", () => {
  test("the same sentence under another subject is another key, and its item gets its own card", async () => {
    expect(sentenceKey(mail("a", "Atlas pricing"))).not.toBe(sentenceKey(mail("b", "Kestrel pricing")));
    const maker = new TitleMaker();
    const e = new CardEnricher({ maker, budget: new Budget(), now: () => T0 });
    e.economize();
    e.enqueue(scope, [mail("a", "Atlas pricing"), mail("b", "Kestrel pricing")]);
    await e.idle();
    expect(maker.sent).toEqual([2]);
    expect(e.cardsOf(scope, ["mail:b"], T0 + 1).get("mail:b")?.entities).toEqual(["Kestrel"]);
    expect(e.cardsOf(scope, ["mail:a"], T0 + 1).get("mail:a")?.entities).toEqual(["Atlas"]);
  });

  test("a reply or forward under the same subject keeps the key; a dated subject has none", () => {
    const key = sentenceKey(mail("a", "Atlas pricing"));
    expect(key).toBeDefined();
    expect(sentenceKey(mail("r", "Re: Atlas  pricing"))).toBe(key);
    expect(sentenceKey(mail("f", "Fwd: RE: atlas pricing", `Hi all, ${BODY}`))).toBe(key);
    expect(sentenceKey(mail("d", "Atlas pricing tomorrow"))).toBeUndefined();
  });

  test("a sentence key goes with the card it points to: the item leaving takes both", async () => {
    const maker = new TitleMaker();
    const e = new CardEnricher({ maker, budget: new Budget(), now: () => T0 });
    e.economize();
    e.enqueue(scope, [mail("a", "Atlas pricing")]);
    await e.idle();
    const u = (e as unknown as { users: Map<string, { bySentence: Map<string, string> }> }).users.get("t/u")!;
    expect(u.bySentence.size).toBe(1);
    e.forgetItems(scope, ["mail:a"]);
    expect(u.bySentence.size).toBe(0);
    // The same sentence later is read afresh: no card of the gone item is lent to it.
    e.enqueue(scope, [mail("b", "Atlas pricing", `Morning, ${BODY}`)]);
    await e.idle();
    expect(maker.sent).toEqual([1, 1]);
  });
});

describe("a cut batch's retry over budget", () => {
  test("counts only the items the cut call left uncovered", async () => {
    const card: Card = {
      kind: "prohibition",
      actions: ["share-external"],
      entities: ["deck"],
      statement: "no sharing",
    };
    class HalfCut implements CardMaker {
      async make(items: ContextItem[]) {
        return { cards: items.map((_, i) => (i === 0 ? card : null)), costUsd: 0.0001, truncated: true };
      }
    }
    // Room for one reserved call only.
    const budget = new Budget({ usdPerUserDay: 0.002, usdPerSession: Infinity, callsPerSession: Infinity });
    const e = new CardEnricher({ maker: new HalfCut(), budget, now: () => T0 });
    e.enqueue(scope, [mail("a", "Deck", BODY), mail("b", "Deck two", BODY), mail("c", "Deck three", BODY)]);
    await e.idle();
    expect(e.stats.retries).toBe(0);
    expect(e.stats.overBudget).toBe(2);
    expect(e.cardsOf(scope, ["mail:a"], T0 + 1).size).toBe(1);
  });
});
