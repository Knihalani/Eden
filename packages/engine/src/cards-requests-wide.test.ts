import { describe, expect, test } from "bun:test";
import { Budget } from "@eden/llm";
import type { ContextItem } from "@eden/protocol";
import {
  CARD_FORM_REQUESTS,
  CARD_FORM_WIDE,
  CardEnricher,
  cardMessages,
  requestMessages,
  type CardBatch,
  type CardMakeOptions,
  type CardMaker,
} from "./cards";
import { checkEngineConfig } from "./config-check";

// `cardsRequestsWide` (trial, F1): form 3's prompt with the requests asked in varied forms, the broad kind of action
// among them; every other word of the prompt is form 3's.

const NOW = Date.parse("2026-10-27T09:00:00Z");
const item: ContextItem = {
  id: "mail:1",
  sourceId: "mail",
  ref: "1",
  title: "Schedule change to booking BPJ8E9",
  text: "Your flight to Porto on Sunday 8 November now lands at 21:40.",
  updatedAt: NOW - 3_600_000,
};

class Recording implements CardMaker {
  forms: CardMakeOptions[] = [];
  async make(
    items: ContextItem[],
    _t: string,
    _s: AbortSignal,
    _r?: boolean,
    _i?: boolean,
    o: CardMakeOptions = {},
  ): Promise<CardBatch> {
    this.forms.push(o);
    return { cards: items.map(() => null), requests: items.map(() => ["book a taxi from the airport"]), costUsd: 0 };
  }
}

describe("cardsRequestsWide", () => {
  test("the prompt adds the varied forms to form 3's, and changes nothing else", () => {
    const fix = cardMessages([item], "2026-10-27", true, CARD_FORM_REQUESTS)[0]!.content;
    const wide = cardMessages([item], "2026-10-27", true, CARD_FORM_WIDE)[0]!.content;
    expect(wide).toContain("one naming the broad kind of action");
    expect(fix).not.toContain("broad kind of action");
    const added = wide.slice(wide.indexOf(" Vary the "), wide.indexOf(" Most items qualify"));
    expect(wide.replace(added, "")).toBe(fix);
    expect(requestMessages([item], "2026-10-27", CARD_FORM_WIDE)[0]!.content).toContain("broad kind of action");
    expect(requestMessages([item], "2026-10-27")[0]!.content).not.toContain("broad kind of action");
  });

  test("the enricher asks in form 4 with the switch, form 3 without", async () => {
    for (const wide of [false, true]) {
      const maker = new Recording();
      const e = new CardEnricher({ maker, budget: new Budget(), now: () => NOW });
      e.intend();
      e.showRequests();
      if (wide) e.wideRequests();
      e.enqueue({ tenantId: "t", userId: "u" }, [item]);
      await e.idle();
      expect(maker.forms[0]).toEqual({ form: wide ? CARD_FORM_WIDE : CARD_FORM_REQUESTS });
    }
  });

  test("needs cardsRequestsFix", () => {
    expect(() => checkEngineConfig({ cardsRequestsFix: false, cardsRequestsWide: true }, { cards: true })).toThrow();
  });
});
