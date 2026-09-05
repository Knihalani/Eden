import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOLD } from "../../../.gauntlet/gold";
import { INJECT_FACTS, INJECT_ROWS } from "../../../.gauntlet/inject";
import { encodePack } from "./pack";
import { openStore } from "./store";
import { injectFromRequest, injectFromText } from "./inject";
import { knowQuery } from "./query";

function factOf(card: { fact?: string; unknown?: true } | { fact: string } | undefined) {
  if (!card) return "";
  return "fact" in card && card.fact ? card.fact : "";
}

describe("locked gold prompts", () => {
  test("every gold line is unknown or a grounded knowQuery card", () => {
    for (const g of GOLD) {
      if (g.expectUnknown) {
        const card = knowQuery(g.query ?? g.prompt);
        expect("unknown" in card, g.id).toBe(true);
        continue;
      }
      const q = g.query ?? g.needle ?? g.prompt;
      const card = q ? knowQuery(q) : undefined;
      const fact = factOf(card);
      expect(fact.length, `${g.id} silent`).toBeGreaterThan(0);
      if (g.expectS) expect(g.expectS.test(fact), `${g.id} S ${fact}`).toBe(true);
      if (g.expectO) expect(g.expectO.test(fact), `${g.id} O ${fact}`).toBe(true);
      if (g.needle) {
        expect(
          fact.toLowerCase().includes(g.needle.toLowerCase()) || new RegExp(g.needle, "i").test(fact),
          `${g.id} needle ${fact}`,
        ).toBe(true);
      }
      expect(fact.split(/\s+/).filter(Boolean).length, `${g.id} tokens`).toBeLessThanOrEqual(48);
    }
  });

  test("wrap inject stays silent on frozen catalog gold prompts", () => {
    for (const g of GOLD) {
      if (g.expectUnknown || g.wrapSilent === false) continue;
      if (!g.prompt) continue;
      const card = injectFromText(g.prompt);
      expect(card, `${g.id} leaked ${card?.fact}`).toBeUndefined();
    }
  });

  test("wrap inject gauntlet: silent stays empty; technique/wrong/stale hit the named card", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-gold-inject-"));
    writeFileSync(join(dir, "graph.kpk"), encodePack(INJECT_FACTS));
    const store = openStore(dir);
    try {
      const misses: string[] = [];
      let silentOk = 0;
      let silentN = 0;
      let hitOk = 0;
      let hitN = 0;
      for (const row of INJECT_ROWS) {
        const card = injectFromRequest({ text: row.text, tools: row.tools, calls: row.calls }, store);
        const got = card?.fact ?? "";
        if (row.want === "silent") {
          silentN++;
          if (!got) silentOk++;
          else misses.push(`${row.id}: wanted silent got ${got}`);
        } else {
          hitN++;
          if (row.want.test(got)) hitOk++;
          else misses.push(`${row.id}: wanted ${row.want} got ${got || "<silent>"}`);
        }
      }
      expect(misses, misses.join("\n")).toEqual([]);
      expect(silentOk).toBe(silentN);
      expect(hitOk).toBe(hitN);
      expect(silentN).toBeGreaterThan(0);
      expect(hitN).toBeGreaterThan(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
