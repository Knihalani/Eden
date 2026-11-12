import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { CardEnricher, type Card, type CardBatch, type CardMaker } from "./cards";
import { checkEngineConfig } from "./config-check";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

// `stateFilterWide` (G2, D1451; docs/research/g2-decoys.md): `pushStateFilter`'s test (an item carded none whose
// state says a constraint cleared) on the two channels that go round the push's pool: the rule paths' proactive
// packets, and an explicit ask in a request the push started for.

const NOW = Date.parse("2026-10-27T09:00:00Z");
const HOUR = 3_600_000;
const scope = { tenantId: "t", userId: "u1" };
const item = (id: string, title: string, text: string, ageH: number): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW - ageH * HOUR,
});
const REQUEST = "Pay the Harlow invoice for the venue deposit today.";
const LIFTED = item(
  "lifted",
  "Harlow venue deposit invoice",
  "Pay the Harlow venue deposit invoice today: the hold on payments to Harlow over the venue deposit is lifted.",
  1,
);
const HOLD = item("hold", "Harlow venue", "Payments to Harlow are on hold until the venue deposit dispute ends.", 4);
const CARDS: Record<string, Card> = {
  "mail:lifted": { kind: "none", actions: [], entities: [], statement: "hold lifted", state: "lifted" },
  "mail:hold": { kind: "freeze", actions: ["pay"], entities: ["Harlow"], statement: "on hold", state: "in_force" },
};

async function setup(config: Record<string, unknown>) {
  // Cards are made only until the first user's are in: the second user's copies get none.
  let carding = true;
  const maker: CardMaker = {
    async make(items: ContextItem[]) {
      return { cards: items.map((it) => (carding ? (CARDS[it.id] ?? null) : null)), costUsd: 0 } as CardBatch;
    },
  };
  const cards = new CardEnricher({ maker, budget: new Budget(), now: () => NOW - HOUR });
  cards.askState();
  const all = [LIFTED, HOLD];
  cards.enqueue(scope, all);
  await cards.idle();
  carding = false;
  const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => all };
  return new ContextPartner({
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
      cardsState: true,
      ...config,
    },
  });
}

const ref = { ...scope, sessionId: "s1" };
const said = (p: ContextPartner, at = ref) =>
  p.observe({ ...at, at: NOW, kind: "user_message", text: REQUEST } as AgentEvent, { waitMs: 2_000 });
const listed = async (p: ContextPartner, at = ref) =>
  (await p.ask({ ...at, question: "Harlow venue deposit invoice", maxItems: 5 })).citations.map((c) => c.itemId);

describe("stateFilterWide (G2, D1451)", () => {
  test("on in the default (D1451), and it needs cards and their state", () => {
    expect(DEFAULT_CONFIG.stateFilterWide).toBe(true);
    expect(() => checkEngineConfig({ cards: false, stateFilterWide: true }, { deps: { cards: true } })).toThrow();
    expect(() => checkEngineConfig({ cardsState: false, stateFilterWide: true }, { deps: { cards: true } })).toThrow();
  });

  test("off: the ask of a pushed request lists the lifted hold; on: it lists only what is in force", async () => {
    const off = await setup({ stateFilterWide: false });
    await said(off);
    expect(await listed(off)).toContain("mail:lifted");
    const on = await setup({ stateFilterWide: true });
    await said(on);
    const got = await listed(on);
    expect(got).not.toContain("mail:lifted");
    expect(got).toContain("mail:hold");
  });

  test("on: an ask in a request the push did not start for lists the lifted hold (a question about the hold)", async () => {
    const p = await setup({ stateFilterWide: true });
    expect(await listed(p)).toContain("mail:lifted");
  });

  test("on: a rule path's packet leaves the lifted hold out", async () => {
    const texts = async (wide: boolean) => {
      const p = await setup({ stateFilterWide: wide, fallbackMatchedTerms: 2, pushCandidates: 0 });
      const res = await said(p);
      return [...(res.injection ? [res.injection] : []), ...p.takePending(ref)].map((x) => x.text).join("\n");
    };
    expect(await texts(false)).toContain("is lifted");
    expect(await texts(true)).not.toContain("is lifted");
  });

  test("isolation: one user's cards never filter another user's ask", async () => {
    const p = await setup({ stateFilterWide: true });
    const other = { tenantId: "t", userId: "u2", sessionId: "s1" };
    await said(p, other);
    expect(await listed(p, other)).toContain("mail:lifted");
  });
});
