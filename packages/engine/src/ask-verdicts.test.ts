import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { CardEnricher, type Card, type CardMaker } from "./cards";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

/**
 * `askVerdicts` (docs/research/gen-ask.md): an ask gathers the lookup's candidates and answers first with those a rule
 * path's verdict says the question runs into.
 */
const NOW = Date.parse("2026-10-27T09:00:00Z");
const HOUR = 3_600_000;
const item = (id: string, title: string, text: string, sourceId = "chat"): ContextItem => ({
  id: `${sourceId}:${id}`,
  sourceId,
  ref: id,
  title,
  text,
});

class TableMaker implements CardMaker {
  constructor(private readonly table: Record<string, Card>) {}
  async make(items: ContextItem[]) {
    return {
      cards: items.map(
        (i) => this.table[i.title] ?? { kind: "none" as const, actions: [], entities: [], statement: "" },
      ),
      costUsd: 0,
    };
  }
}

const anySource = (items: ContextItem[]): Source => ({
  id: "chat",
  kind: "test",
  description: "Team chat",
  search: async (q) => {
    const words = q.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    return items.filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)));
  },
});

// Shares no word with the deploy question: only its card ties it to the question.
const kestrel = item("k1", "Kestrel snapshot", "Kestrel cluster stays read-only from 4 Nov until 9 Nov for the audit.");
// Share the question's words, and say nothing it runs into.
const fillers = [1, 2, 3, 4, 5, 6].map((n) =>
  item(`m${n}`, `Billing migration notes ${n}`, `Deploy checklist for the billing migration, part ${n}.`),
);
const cards: Record<string, Card> = {
  "Kestrel snapshot": {
    kind: "freeze",
    actions: ["deploy"],
    entities: ["Kestrel cluster"],
    statement: "Kestrel frozen",
    start: "2026-11-04",
    end: "2026-11-09",
  },
};
const QUESTION = "Deploy the billing migration on Thursday 5 November.";

async function ask(config: Record<string, unknown>, users = ["u1"], seeded = ["u1"]) {
  let clock = NOW;
  const enricher = new CardEnricher({ maker: new TableMaker(cards), budget: new Budget(), now: () => clock });
  const p = new ContextPartner({
    sources: async () => [anySource([kestrel, ...fillers])],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => clock,
    config: { ...CORE_CONFIG, cards: true, groundConflict: true, ...config },
    cards: enricher,
  });
  const out: Record<string, { ids: string[]; answer: string }> = {};
  for (const userId of users) {
    const scope = { tenantId: "t", userId };
    if (seeded.includes(userId)) {
      // An earlier lookup brings the item into this user's cache; its card is made in the background.
      const ev = { ...scope, sessionId: "s1", at: clock, kind: "user_message", text: "Any news on Kestrel?" };
      await p.observe(ev as AgentEvent, { waitMs: 1_000 });
      await enricher.idle();
    }
    clock += HOUR;
    const a = await p.ask({ ...scope, sessionId: "s2", question: QUESTION });
    out[userId] = { ids: a.citations.map((c) => c.itemId), answer: a.answer };
  }
  return out;
}

describe("askVerdicts", () => {
  test("a cached item whose card the question violates answers it first; flag off, the lexical answer stands", async () => {
    const on = await ask({ askVerdicts: true });
    expect(on.u1!.ids[0]).toBe("chat:k1");
    // The question's lexical matches follow it.
    expect(on.u1!.ids.length).toBeGreaterThan(1);
    const off = await ask({});
    expect(off.u1!.ids).not.toContain("chat:k1");
  });

  test("per user: another user's cached item and card never reach this user's answer", async () => {
    const out = await ask({ askVerdicts: true }, ["u1", "u2"], ["u1"]);
    expect(out.u1!.ids).toContain("chat:k1");
    expect(out.u2!.ids).not.toContain("chat:k1");
  });
});
