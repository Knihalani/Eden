import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

// D2088: the packet cap — min(maxItemsPerInjection, confidentItems) — paces the agent's attention, not the
// engine's confidence. Past it, one item still rides when it is at least twice as sure as the confident floor;
// a merely sure item does not stretch the packet.

const NOW = Date.parse("2026-10-27T09:00:00Z");
const ref = { tenantId: "t", userId: "u1", sessionId: "s1" };
const REQUEST =
  "Pull together the october board pack: the invoice ledger, vendor accounts, the quarterly report and the budget forecast.";
// The request's content terms; a "strong" item carries them all (~1.0 coverage), a "weak" one about half. Each
// item's tail is its own prose so the near-duplicate pass keeps them all.
const ALL = "october board pack invoice ledger vendor accounts quarterly report budget forecast";
const SOME = "october board pack invoice ledger";

const item = (id: string, title: string, text: string): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW - 3_600_000,
});
const strong = (id: string, tail: string) => item(id, tail, `${ALL} — ${tail}`);
const weak = (id: string, tail: string) => item(id, tail, `${SOME} — ${tail}`);

function partner(items: ContextItem[], config: Record<string, unknown> = {}) {
  const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => items };
  return new ContextPartner({
    sources: async () => [source],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => NOW,
    config: {
      ...CORE_CONFIG,
      confidentScore: 0.4,
      minMatchedTerms: 1,
      quietNameOnly: false,
      askReader: false,
      readerPush: false,
      readerGate: false,
      ...config,
    },
  });
}
async function packet(p: ContextPartner) {
  const result = await p.observe({ ...ref, at: NOW, kind: "user_message", text: REQUEST } as AgentEvent, {
    waitMs: 2_000,
  });
  return (result.injection?.citations ?? []).map((c) => c.itemId).sort();
}

describe("the confident packet's overflow slot (D2088)", () => {
  test("a fourth item twice as sure as the floor rides past the cap", async () => {
    const p = partner([
      strong("a", "Treasury memo on liquidity buffers and gilt exposure ahead of the refinancing window"),
      strong("b", "Office lease renewal comparison across the shortlisted Manchester and Leeds properties"),
      strong("c", "Warehouse forklift procurement bids with safety audit notes and maintenance schedules"),
      strong("d", "Payroll provider migration checklist covering pensions sync and holiday accrual rules"),
    ]);
    const ids = await packet(p);
    expect(ids).toEqual(["mail:a", "mail:b", "mail:c", "mail:d"]);
  });

  test("a merely sure fourth item does not stretch the packet", async () => {
    const p = partner([
      strong("a", "Treasury memo on liquidity buffers and gilt exposure ahead of the refinancing window"),
      strong("b", "Office lease renewal comparison across the shortlisted Manchester and Leeds properties"),
      strong("c", "Warehouse forklift procurement bids with safety audit notes and maintenance schedules"),
      weak("e", "Canteen supplier tasting notes from the spring menu review panel"),
    ]);
    const ids = await packet(p);
    expect(ids).toEqual(["mail:a", "mail:b", "mail:c"]);
  });

  test("the packet never grows past cap + 1", async () => {
    const p = partner([
      strong("a", "Treasury memo on liquidity buffers and gilt exposure ahead of the refinancing window"),
      strong("b", "Office lease renewal comparison across the shortlisted Manchester and Leeds properties"),
      strong("c", "Warehouse forklift procurement bids with safety audit notes and maintenance schedules"),
      strong("d", "Payroll provider migration checklist covering pensions sync and holiday accrual rules"),
      strong("e", "Energy contract renegotiation brief with consumption history and green tariff quotes"),
    ]);
    const ids = await packet(p);
    expect(ids.length).toBe(4);
  });
});
