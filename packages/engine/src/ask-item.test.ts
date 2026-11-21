import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { StaticSource } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { ITEM_GONE } from "./partner-verdict";
import { CORE_CONFIG } from "./parts";

// A2 (D2022): an `itemId` ask returns the cited item's parts bearing on the question in full — an ordinary
// answer's excerpts stop at `askItemBytes`, and the agent had no way to ask for the rest. The cache is the only
// source read; no search, no model, nothing charged.

const NOW = Date.parse("2026-10-27T09:00:00Z");
const partner = (items: { ref: string; title: string; text: string }[]) =>
  new ContextPartner({
    sources: async () => [new StaticSource("mail", "mail", items)],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => NOW,
    config: { ...CORE_CONFIG, confidentScore: 99, fallbackMatchedTerms: 99, compactAsk: true },
  });
const ref = { tenantId: "t", userId: "u", sessionId: "s" };

describe("A2: the `item` ask returns a cited item in full", () => {
  test("the item ask returns its parts in full where the answer's excerpt was cut", async () => {
    // Past `askItemBytes`' cut: the tail can only arrive by an `item` ask.
    const tail = "the venue deposit cleared on the last day of October";
    // Distinct sentences, so the parts picker cannot collapse them and reach the tail inside 320 bytes.
    const text =
      `Harlow invoice dispute update. ` +
      Array.from({ length: 40 }, (_, i) => `Catering note ${i} for the venue team. `).join("") +
      tail;
    const p = partner([{ ref: "m1", title: "Harlow invoice", text }]);
    const first = await p.ask({ ...ref, question: "Harlow invoice" });
    const itemId = first.citations[0]!.itemId;
    expect(itemId).toBe("mail:m1");
    // Precondition: the ordinary answer's excerpt (cut at `askItemBytes`) left the tail out.
    expect(first.answer).not.toContain(tail);
    // The question bears none of the tail's words, so only the item path can bring it back.
    const again = await p.ask({ ...ref, question: "Harlow invoice", itemId });
    expect(again.citations.map((c) => c.itemId)).toEqual([itemId]);
    expect(again.answer).toContain(tail);
    expect(again.answer).toContain("Harlow invoice");
    expect(again.usedModel).toBe(false);
    expect(again.costUsd).toBe(0);
  });

  test("the item ask reads the cache alone: no connector list, no search, nothing charged", async () => {
    const mail = new StaticSource("mail", "mail", [{ ref: "m1", title: "Harlow", text: "Harlow invoice" }]);
    let sourcesCalls = 0;
    const p = new ContextPartner({
      sources: async () => (sourcesCalls++, [mail]),
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => NOW,
      config: { ...CORE_CONFIG, confidentScore: 99, fallbackMatchedTerms: 99, compactAsk: true },
    });
    await p.ask({ ...ref, question: "Harlow" });
    const calls = sourcesCalls;
    const again = await p.ask({ ...ref, question: "Harlow", itemId: "mail:m1" });
    expect(again.answer).toContain("Harlow invoice");
    expect(again.citations.map((c) => c.itemId)).toEqual(["mail:m1"]);
    expect(sourcesCalls).toBe(calls);
  });

  test("a gone item says so, citing nothing", async () => {
    const p = partner([{ ref: "m1", title: "Harlow invoice", text: "Harlow invoice" }]);
    await p.ask({ ...ref, question: "Harlow" });
    const res = await p.ask({ ...ref, question: "Harlow", itemId: "mail:gone" });
    expect(res.answer).toBe(ITEM_GONE);
    expect(res.citations).toEqual([]);
    expect(res.usedModel).toBe(false);
    expect(res.costUsd).toBe(0);
  });
});
