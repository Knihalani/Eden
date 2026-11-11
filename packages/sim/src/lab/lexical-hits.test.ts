import { describe, expect, test } from "bun:test";
import { CANDIDATES_LEAD } from "@eden/engine";
import { worldOf } from "./ab-common";
import { hitsPacket, HITS_K, topHits } from "./lexical-hits";
import { parseCondition } from "./pi-conditions";

describe("the hits arm (P3, D831)", () => {
  const { world, tasks } = worldOf(41, "train1", "hidden", { maxTasks: 1_000, maxOffworld: 0 });

  test("ranks every source's items by the request's words and keeps the default's five", () => {
    const hits = topHits(world, tasks[0]!.text);
    expect(hits.length).toBe(HITS_K);
    expect(HITS_K).toBe(5);
    // Over all sources at once, not one source's index.
    expect(new Set(world.items.map((i) => i.sourceId)).size).toBeGreaterThan(1);
    for (const h of hits) expect(world.items.some((i) => i.id === h.id)).toBe(true);
  });

  test("the packet is Eden's candidates envelope and lead, citing the hits in order", () => {
    const p = hitsPacket(world, tasks[0]!.text)!;
    const lines = p.text.split("\n");
    expect(lines[0]).toStartWith("<context ");
    expect(lines[1]).toBe(CANDIDATES_LEAD);
    expect(lines.at(-1)).toBe("</context>");
    expect(p.citations.map((c) => c.itemId)).toEqual(topHits(world, tasks[0]!.text).map((i) => i.id));
  });

  test("a request with no word in any item gets no packet", () => {
    expect(hitsPacket(world, "zzqx qqvv")).toBeNull();
  });

  test("the condition runs no Eden, no tools and no ask, and takes no Eden settings", () => {
    const c = parseCondition("hits", { config: {} });
    expect(c).toMatchObject({ hits: true, useEden: false, withPartner: false, useTools: false, askTool: false });
    expect(parseCondition("eden", { config: {} }).hits).toBe(false);
    expect(() => parseCondition("hits+pushOpen", { config: {} })).toThrow();
    expect(() => parseCondition("hits@w0", { config: {} })).toThrow();
  });
});
