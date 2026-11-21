import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent } from "@eden/protocol";
import { StaticSource, type Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner, type PartnerDeps } from "./partner";
import { CORE_CONFIG } from "./parts";

// Thursday 19 November 2026, noon UTC.
const AT = Date.parse("2026-11-19T12:00:00Z");
const scope = { tenantId: "acme-assistant", userId: "u1" };

const docs = new StaticSource("docs", "the user's documents", [
  {
    ref: "statement",
    title: "Monzo: your November statement",
    text: "Monzo current account. Standing order to Meridian Rent Ltd (£1,450.00) left on the 1st as usual. Balance £2,310.42.",
  },
  {
    ref: "tax-code",
    title: "HMRC — your tax code has changed",
    text: "New tax code 1257L effective 6 December 2026 (was 1180L). PAYE reference 845/AB123. HMRC",
  },
  {
    ref: "home-admin",
    title: "Wi-Fi + home admin",
    text: "Home wifi (current, Crouch Hill): SSID 'HillTop88', password 'crouch-wren-42'. Landlord agent: Meridian Rent Ltd, ref RAG-8841, emergencies 020 7946 0331.",
  },
  {
    ref: "bonds",
    title: "NS&I Premium Bonds",
    text: "Your Premium Bonds holding is £12,000. This month's draw results are out now. NS&I",
  },
]);

async function warm(sources: Source[], extra: Partial<PartnerDeps> = {}) {
  const p = new ContextPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => AT,
    ...extra,
    config: { ...CORE_CONFIG, askExpand: true, ...extra.config },
  });
  const sessionId = "s1";
  await p.observe({ ...scope, sessionId, at: AT, kind: "session_start" } as AgentEvent, { waitMs: 50 });
  await p.observe(
    { ...scope, sessionId, at: AT, kind: "user_message", text: "hi, catch me up on admin" } as AgentEvent,
    { waitMs: 2_000 },
  );
  return { p, sessionId };
}

describe("askExpand: an ask's words read as OR-groups of stems and phrasing-family words (D2029)", () => {
  test("a phrasing the item writes differently still ranks its item: 'emergency number' meets 'emergencies', 'who manages' meets 'landlord agent'", async () => {
    const { p, sessionId } = await warm([docs]);
    const res = await p.ask({
      ...scope,
      sessionId,
      question: "who manages my flat and what's their emergency number?",
    });
    expect(res.citations.map((c) => c.itemId)).toContain("docs:home-admin");
  });

  test("a synonym group outranks common-word overlap: 'how much rent' finds the statement, not the bonds' 'month'", async () => {
    const { p, sessionId } = await warm([docs]);
    const res = await p.ask({ ...scope, sessionId, question: "how much rent do I pay each month now?" });
    expect(res.citations.map((c) => c.itemId)).toContain("docs:statement");
    expect(res.citations.map((c) => c.itemId)).not.toContain("docs:tax-code");
  });

  test("a compound word keeps its exact match: 'wi-fi' is one term, not 'wi' and 'fi'", async () => {
    const { p, sessionId } = await warm([docs]);
    const res = await p.ask({ ...scope, sessionId, question: "what's my wi-fi password?" });
    expect(res.citations.map((c) => c.itemId)).toContain("docs:home-admin");
  });

  test("off, the phrasing miss returns: no expansion, 'who manages' finds nothing on these docs", async () => {
    const { p, sessionId } = await warm([docs], { config: { ...CORE_CONFIG, askExpand: false } });
    const res = await p.ask({
      ...scope,
      sessionId,
      question: "who manages my flat and what's their emergency number?",
    });
    expect(res.citations.map((c) => c.itemId)).not.toContain("docs:home-admin");
  });
});
