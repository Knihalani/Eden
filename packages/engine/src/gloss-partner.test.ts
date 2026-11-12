import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { StaticSource, type StaticDoc } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

/** Tuesday 27 October 2026, 09:00 UTC. */
const NOW = Date.parse("2026-10-27T09:00:00Z");

/** English items; the user writes in Portuguese. */
const DOCS: StaticDoc[] = [
  {
    ref: "repairs",
    title: "Tenancy: repairs",
    text: "From: Harlow Lettings <office@harlow.example>\n\nThe landlord arranges every plumber for the flat: report a leak to us first.",
  },
  {
    ref: "gym",
    title: "Gym renewal",
    text: "From: Vitalis <hello@vitalis.example>\n\nYour gym membership renews on 1 December.",
  },
];

async function cited(question: string, requestGloss: boolean): Promise<string[]> {
  const p = new ContextPartner({
    sources: async () => [new StaticSource("mail", "Mail", DOCS)],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => NOW,
    config: { ...CORE_CONFIG, requestGloss },
  });
  const r = await p.ask({ tenantId: "t", userId: "u", sessionId: "s", question });
  return r.citations.map((c) => c.itemId);
}

describe("requestGloss", () => {
  // The shipped glossary (gloss.bin): "canalizador" plumber, "fuga" leak, "cozinha" kitchen.
  const pt = "Preciso de um canalizador para ver a fuga debaixo do lava-loiça da cozinha.";

  test("a request in another language finds an English item by the words its own words mean", async () => {
    expect(await cited(pt, false)).not.toContain("mail:repairs");
    expect(await cited(pt, true)).toContain("mail:repairs");
  });

  test("an English request is searched as written", async () => {
    const en = "Book a plumber to look at the leak under the kitchen sink.";
    expect(await cited(en, true)).toEqual(await cited(en, false));
  });
});
