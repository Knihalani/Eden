import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { StaticSource, type StaticDoc } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

/** Tuesday 27 October 2026, 09:00 UTC. */
const NOW = Date.parse("2026-10-27T09:00:00Z");

/** English items; the user writes in German. */
const DOCS: StaticDoc[] = [
  {
    ref: "mandate",
    title: "Change to your account mandate",
    text: "From: Northgate Bank <alerts@northgate.example>\n\nYour joint account now needs both holders to approve any invoice payment.",
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
  // The shipped glossary (gloss.bin): "Rechnung" invoice, "gemeinsamen" joint, "Konto" account, "bezahlen" pay.
  const de = "Ich muss heute die Rechnung des Küchenbauers über 1.450 Pfund vom gemeinsamen Konto bezahlen.";

  test("a request in another language finds an English item by the words its own words mean", async () => {
    expect(await cited(de, false)).not.toContain("mail:mandate");
    expect(await cited(de, true)).toContain("mail:mandate");
  });

  test("an English request is searched as written", async () => {
    const en = "Pay the kitchen fitter's invoice from the joint account today.";
    expect(await cited(en, true)).toEqual(await cited(en, false));
  });
});
