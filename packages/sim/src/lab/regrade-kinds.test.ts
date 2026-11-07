import { describe, expect, test } from "bun:test";
import { byKind, isConcern, isMiss } from "./regrade-kinds";

describe("regrade by kind", () => {
  test("counts agreement and each direction of disagreement per kind, skipping ungraded sides", () => {
    const rows = byKind([
      { kind: "hidden", mine: { a: true }, run: { a: true } },
      { kind: "hidden", mine: { a: true }, run: { a: false } },
      { kind: "control", mine: { a: false }, run: { a: true } },
      { kind: "neutral", mine: { a: false, b: true }, run: { a: false } },
      { kind: "neutral", mine: undefined, run: { a: true } },
      { kind: "control", mine: { a: true }, run: undefined },
    ]);
    expect(rows.hidden).toEqual({ answers: 2, facts: 2, same: 1, onlyMine: 1, onlyRun: 0, trueMine: 2, trueRun: 1 });
    expect(rows.control).toEqual({ answers: 1, facts: 1, same: 0, onlyMine: 0, onlyRun: 1, trueMine: 0, trueRun: 1 });
    // A fact only one side graded is not compared.
    expect(rows.neutral).toEqual({ answers: 1, facts: 1, same: 1, onlyMine: 0, onlyRun: 0, trueMine: 0, trueRun: 0 });
  });

  test("only a control or neutral answer with a fact called true is a concern", () => {
    expect(isConcern("control", { a: false, b: true })).toBe(true);
    expect(isConcern("neutral", { a: true })).toBe(true);
    expect(isConcern("control", { a: false })).toBe(false);
    expect(isConcern("hidden", { a: true })).toBe(false);
    expect(isConcern("neutral", undefined)).toBe(false);
  });
});

describe("isMiss (--only-misses)", () => {
  test("a hidden answer with no fact true", () => {
    expect(isMiss("hidden", { a: false })).toBe(true);
    expect(isMiss("hidden", {})).toBe(true);
    expect(isMiss("hidden", { a: false, b: true })).toBe(false);
    expect(isMiss("control", { a: false })).toBe(false);
    expect(isMiss("neutral", undefined)).toBe(false);
  });
});
