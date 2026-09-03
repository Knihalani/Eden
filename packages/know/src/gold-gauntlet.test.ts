import { describe, expect, test } from "bun:test";
import { GOLD } from "../../../.gauntlet/gold";
import { injectFromText } from "./inject";
import { knowQuery } from "./query";

function factOf(card: { fact?: string; unknown?: true } | { fact: string } | undefined) {
  if (!card) return "";
  return "fact" in card && card.fact ? card.fact : "";
}

describe("locked gold prompts", () => {
  test("every gold line is unknown or a grounded card", () => {
    for (const g of GOLD) {
      if (g.expectUnknown) {
        const card = knowQuery(g.query ?? g.prompt);
        expect("unknown" in card, g.id).toBe(true);
        continue;
      }
      const inj = g.prompt ? injectFromText(g.prompt) : undefined;
      const q = g.query ?? g.needle;
      const card = q ? knowQuery(q) : undefined;
      const fact = factOf(inj) || factOf(card);
      expect(fact.length, `${g.id} silent`).toBeGreaterThan(0);
      if (g.expectO) expect(g.expectO.test(fact), `${g.id} ${fact}`).toBe(true);
      if (g.needle) expect(fact.toLowerCase().includes(g.needle.toLowerCase()) || new RegExp(g.needle, "i").test(fact), `${g.id} needle ${fact}`).toBe(true);
      expect(fact.split(/\s+/).filter(Boolean).length, `${g.id} tokens`).toBeLessThanOrEqual(48);
    }
  });
});
