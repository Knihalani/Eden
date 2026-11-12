/** F10's rule index helpers: the shared text recipe, the card score and the selection order. */
import { describe, expect, test } from "bun:test";
import { RULE_DAY_PENALTY, ruleScore, ruleTexts, topRules, type RuleCandidate } from "./rule-index";

const card = (over: Partial<RuleCandidate> = {}): RuleCandidate => ({
  id: "c",
  kind: "freeze",
  statement: "office closed",
  title: "Office",
  source: "mail",
  ...over,
});

describe("rule index helpers (F10)", () => {
  test("texts: statement and title as passages, anticipated requests as queries", () => {
    expect(ruleTexts(card({ requests: ["go to the office"] }))).toEqual({
      passages: ["office closed", "Office. office closed"],
      queries: ["go to the office"],
    });
  });

  test("score: the mean of the best two cosines; NaN with none", () => {
    expect(ruleScore([0.9, 0.5, 0.7], card())).toBeCloseTo(0.8);
    expect(ruleScore([0.6], card())).toBeCloseTo(0.6);
    expect(Number.isNaN(ruleScore([], card()))).toBe(true);
  });

  test("score: a span that holds none of the request's days is demoted; no days or no span, untouched", () => {
    const c = card({ start: "2026-11-02", end: "2026-11-06" });
    expect(ruleScore([0.8], c, ["2026-11-10"])).toBeCloseTo(0.8 - RULE_DAY_PENALTY);
    expect(ruleScore([0.8], c, ["2026-11-03", "2026-11-10"])).toBeCloseTo(0.8);
    expect(ruleScore([0.8], c, [])).toBeCloseTo(0.8);
    expect(ruleScore([0.8], card(), ["2026-11-10"])).toBeCloseTo(0.8);
  });

  test("top: best first, ties by id, unscored left out, at most k", () => {
    const s = new Map([
      ["b", 0.5],
      ["a", 0.5],
      ["c", 0.9],
      ["d", Number.NaN],
    ]);
    expect(topRules(s, 3)).toEqual(["c", "a", "b"]);
    expect(topRules(s, 1)).toEqual(["c"]);
    expect(topRules(s, 0)).toEqual([]);
  });
});
