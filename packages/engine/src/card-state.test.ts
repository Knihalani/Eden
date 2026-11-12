import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import {
  CARD_FORM_REQUESTS,
  CARD_FORM_STATE,
  CardEnricher,
  cardMessages,
  parseCards,
  type Card,
  type CardBatch,
  type CardMakeOptions,
  type CardMaker,
} from "./cards";
import { checkEngineConfig } from "./config-check";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

// `cardsState` and `pushStateFilter` (F2, D1193, on in the default; docs/research/f2-card-state.md): the card model
// says whether an item's constraint is in force, lifted, met or superseded, and the push's pool leaves out an item
// carded none because a constraint was lifted, met or superseded.

const NOW = Date.parse("2026-10-27T09:00:00Z");
const HOUR = 3_600_000;
const scope = { tenantId: "t", userId: "u1" };

const item = (id: string, title: string, text: string, ageH = 24): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW - ageH * HOUR,
});

describe("the card's state", () => {
  test("parseCards reads a known state and ignores any other", () => {
    const text = JSON.stringify({
      cards: [
        { i: 0, kind: "freeze", actions: ["pay"], entities: ["Harlow"], statement: "hold", state: "in_force" },
        { i: 1, kind: "none", actions: [], entities: [], statement: "hold lifted", state: "lifted" },
        { i: 2, kind: "freeze", actions: ["pay"], entities: [], statement: "x", state: "gone" },
      ],
    });
    const [a, b, c] = parseCards(text, 3);
    expect(a?.state).toBe("in_force");
    expect(b?.state).toBe("lifted");
    expect(c?.state).toBeUndefined();
  });

  test("the prompt asks for the state only in its form; the shipped text is unchanged", () => {
    const items = [item("a", "Harlow", "Payments to Harlow are on hold.")];
    const shipped = cardMessages(items, "2026-10-27", true, CARD_FORM_REQUESTS)[0]!.content;
    const stated = cardMessages(items, "2026-10-27", true, CARD_FORM_REQUESTS + CARD_FORM_STATE)[0]!.content;
    expect(shipped).not.toContain('"state"');
    expect(stated).toContain('"state"');
    // The requests list still shows in the example with the state flag on.
    expect(stated).toContain('Nov"}],"requests":[...]}');
    expect(cardMessages(items, "2026-10-27", true, CARD_FORM_STATE)[0]!.content).not.toContain('"requests":[...]');
  });

  test("parseCards drops the state of a constraint it turns into none (no action it could match)", () => {
    const text = JSON.stringify({
      cards: [{ i: 0, kind: "status-change", actions: [], entities: [], statement: "retimed", state: "superseded" }],
    });
    const [a] = parseCards(text, 1);
    expect(a?.kind).toBe("none");
    expect(a?.state).toBeUndefined();
  });

  test("the enricher asks in the state form and keeps a none card only when it says why, about its item", async () => {
    const forms: (number | undefined)[] = [];
    const none = (statement: string, state?: Card["state"]): Card => ({
      kind: "none",
      actions: [],
      entities: [],
      statement,
      ...(state ? { state } : {}),
    });
    const said: Record<string, Card> = {
      "mail:a": none("Harlow payment hold lifted", "lifted"),
      "mail:b": none(""),
      // Crossed indexes: a cleared none card that shares no word with its item is not kept.
      "mail:c": none("Kitchen fitters booking confirmed", "met"),
    };
    const maker: CardMaker = {
      async make(
        items: ContextItem[],
        _t: string,
        _s: AbortSignal,
        _r?: boolean,
        intent?: boolean,
        o?: CardMakeOptions,
      ) {
        forms.push(o?.form);
        return {
          cards: items.map((it) => said[it.id] ?? null),
          ...(intent ? { requests: items.map(() => ["pay the Harlow invoice"]) } : {}),
          costUsd: 0,
        } as CardBatch;
      },
    };
    const e = new CardEnricher({ maker, budget: new Budget(), now: () => NOW });
    e.intend();
    e.askState();
    const items = [
      item("a", "Harlow hold lifted", "The hold on Harlow payments is lifted; pay the invoice."),
      item("b", "News", "Hi, the Harlow newsletter is out; pay us a visit."),
      item("c", "Payments on hold", "Payments to Harlow are on hold until the dispute ends."),
    ];
    e.enqueue(scope, items);
    await e.idle();
    expect(forms[0]).toBe(CARD_FORM_STATE);
    const got = e.cardsOf(scope, ["mail:a", "mail:b", "mail:c"], NOW + 1);
    expect(got.get("mail:a")?.state).toBe("lifted");
    expect(got.has("mail:b")).toBe(false);
    expect(got.has("mail:c")).toBe(false);
    // A cleared none card is no constraint to the intent index (`intentByKind`'s carded seats) or `carded()`.
    const found = e.intentFinds(scope, "pay the Harlow invoice", NOW + 1, 5, () => true);
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) expect(f.carded).toBe(false);
    expect(e.carded(scope)).toEqual([]);
  });

  test("both switches need cards and are on in the default (D1193)", () => {
    expect(DEFAULT_CONFIG.cardsState).toBe(true);
    expect(DEFAULT_CONFIG.pushStateFilter).toBe(true);
    expect(() => checkEngineConfig({ cards: false, cardsState: true }, { deps: { cards: true } })).toThrow();
    expect(() => checkEngineConfig({ cards: false, pushStateFilter: true }, { deps: { cards: true } })).toThrow();
    // The filter acts only on states, which only `cardsState` writes.
    expect(() => checkEngineConfig({ cardsState: false, pushStateFilter: true }, { deps: { cards: true } })).toThrow();
    expect(() =>
      checkEngineConfig({ cardsState: true, pushStateFilter: true }, { deps: { cards: true } }),
    ).not.toThrow();
  });
});

describe("pushStateFilter", () => {
  const REQUEST = "Pay the Harlow invoice for the venue deposit today.";
  const LIFTED = item(
    "lifted",
    "Harlow venue deposit invoice",
    "Pay the Harlow venue deposit invoice today: the hold on payments to Harlow over the venue deposit is lifted.",
    1,
  );
  const PAID = item("paid", "Harlow deposit", "Already paid: the Harlow venue deposit invoice went out on Friday.", 3);
  const HOLD = item("hold", "Harlow venue", "Payments to Harlow are on hold until the venue deposit dispute ends.", 4);
  const CARDS: Record<string, Card> = {
    "mail:lifted": { kind: "none", actions: [], entities: [], statement: "hold lifted", state: "lifted" },
    // Already done, though it says a condition was met: the fact in force stays.
    "mail:paid": { kind: "already-done", actions: ["pay"], entities: ["Harlow"], statement: "paid", state: "met" },
    "mail:hold": { kind: "freeze", actions: ["pay"], entities: ["Harlow"], statement: "on hold", state: "in_force" },
  };

  async function handed(filter: boolean, pool = 15): Promise<string> {
    const maker: CardMaker = {
      async make(items: ContextItem[]) {
        return { cards: items.map((it) => CARDS[it.id] ?? null), costUsd: 0 } as CardBatch;
      },
    };
    const cards = new CardEnricher({ maker, budget: new Budget(), now: () => NOW - HOUR });
    const all = [LIFTED, PAID, HOLD];
    cards.enqueue(scope, all);
    await cards.idle();
    const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => all };
    const p = new ContextPartner({
      sources: async () => [source],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      cards,
      now: () => NOW,
      config: {
        ...CORE_CONFIG,
        cards: true,
        askReader: true,
        readerPush: true,
        readerGate: true,
        confidentScore: 99,
        fallbackMatchedTerms: 99,
        pushCandidates: 5,
        askReaderPool: pool,
        cardsState: filter,
        pushStateFilter: filter,
      },
    });
    const ref = { ...scope, sessionId: "s1" };
    await p.observe({ ...ref, at: NOW, kind: "user_message", text: REQUEST } as AgentEvent, { waitMs: 2_000 });
    return p
      .takePending(ref)
      .filter((x) => x.reason.startsWith("candidates:"))
      .map((x) => x.text)
      .join("\n");
  }

  test("off, the lifted hold is handed; on, it leaves the pool and the facts in force stay", async () => {
    const off = await handed(false);
    expect(off).toContain("is lifted");
    const on = await handed(true);
    expect(on).not.toContain("is lifted");
    expect(on).toContain("Already paid");
    expect(on).toContain("on hold until");
  });

  test("a seat the filter empties goes to the next ranked item", async () => {
    // A pool of two: the lifted hold holds a seat when off, so one of the facts in force is out of it.
    const off = await handed(false, 2);
    expect(off).toContain("is lifted");
    const on = await handed(true, 2);
    expect(on).not.toContain("is lifted");
    expect(on).toContain("Already paid");
    expect(on).toContain("on hold until");
  });
});
