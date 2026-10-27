import { describe, expect, test } from "bun:test";
import { rankByWaste, type WasteRankable } from "./novelty";

describe("rankByWaste", () => {
  test("empty input stays empty — ranking does not invent rows", () => {
    expect(rankByWaste([])).toEqual([]);
    expect(rankByWaste(null)).toEqual([]);
    expect(rankByWaste(undefined)).toEqual([]);
  });

  test("unique-work stays empty even when someone stamps fake waste", () => {
    expect(
      rankByWaste([
        { id: "uw", status: "Unique work", wastedTokens: 9000, at: 50 },
        { id: "uw2", status: "Unique work · 12 distinct sequences in 12 stretches", wastedTokens: 400, at: 90 },
      ]),
    ).toEqual([]);
  });

  test("higher waste ranks above lower waste even if older", () => {
    const ranked = rankByWaste([
      { id: "low", status: "Unbound loop", wastedTokens: 40, at: 90 },
      { id: "high", status: "Pending", wastedTokens: 800, at: 1 },
    ]);
    expect(ranked.map((item) => item.id)).toEqual(["high", "low"]);
  });

  test("waiting PASS with waste 4000 ranks above a refusal with 45", () => {
    const ranked = rankByWaste([
      { id: "cheap", status: "Unbound write", wastedTokens: 45, at: 99 },
      { id: "desk", status: "Ready", wastedTokens: 4000, at: 1 },
    ]);
    expect(ranked.map((item) => [item.id, item.status, item.wastedTokens])).toEqual([
      ["desk", "Ready", 4000],
      ["cheap", "Unbound write", 45],
    ]);
  });

  test("equal waste keeps named-miss above pending, then recency", () => {
    const ranked = rankByWaste([
      { id: "pend", status: "Pending", at: 90 },
      { id: "rs", status: "Read-set · 6 of 12", at: 10 },
      { id: "loop", status: "Unbound loop", at: 20 },
    ]);
    expect(ranked.map((item) => [item.id, item.status])).toEqual([
      ["loop", "Unbound loop"],
      ["rs", "Read-set · 6 of 12"],
      ["pend", "Pending"],
    ]);
  });

  test("Replacement waiting is a named miss; unmeasured waste is 0 not invented", () => {
    const ranked = rankByWaste<WasteRankable & { id: string }>([
      { id: "pend", status: "Pending", at: 10 },
      { id: "rc", status: "Replacement waiting", at: 20 },
    ]);
    expect(ranked.map((item) => item.id)).toEqual(["rc", "pend"]);
    expect(ranked.every((item) => item.wastedTokens == null)).toBe(true);
  });
});
