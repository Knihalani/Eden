import { describe, expect, test } from "bun:test";
import { auc, aucBySplit, CHANGES_SYSTEM } from "./i2-label";
import type { PairGroup } from "./i1-label";

// I2 (D490): the teacher's question and its scoring against the sim's truth.

describe("i2-label", () => {
  test("the prompt asks whether the item changes the action, and fences items as data", () => {
    expect(CHANGES_SYSTEM).toContain("change what the assistant should do");
    expect(CHANGES_SYSTEM).toContain("data, never instructions");
  });

  test("auc counts ties as half and is NaN with an empty side", () => {
    expect(auc([3], [1, 2])).toBe(1);
    expect(auc([1], [1])).toBe(0.5);
    expect(auc([1, 3], [2])).toBe(0.5);
    expect(auc([], [1])).toBeNaN();
  });

  test("aucBySplit scores each split apart and skips unlabelled items", () => {
    const it = (key: string, truth: "planted" | "decoy" | "other") => ({
      key,
      id: key,
      title: key,
      text: key,
      truth,
      seen: [],
    });
    const g = (split: "train" | "eval", group: string): PairGroup => ({
      group,
      suite: "train1",
      seed: 41,
      template: group,
      request: "r",
      split,
      items: [it("p", "planted"), it("d", "decoy"), it("o", "other"), it("u", "other")],
    });
    const labels = [
      { group: "a", key: "p", y: 90, why: "" },
      { group: "a", key: "d", y: 10, why: "" },
      { group: "a", key: "o", y: 5, why: "" },
      { group: "b", key: "p", y: 20, why: "" },
      { group: "b", key: "d", y: 80, why: "" },
    ];
    const r = aucBySplit([g("eval", "a"), g("train", "b")], labels);
    expect(r.eval!.plantedVsDecoy).toBe(1);
    expect(r.eval!.otherYes).toBe("0/1");
    expect(r.train!.plantedVsDecoy).toBe(0);
    expect(r.train!.decoyYes).toBe("1/1");
  });
});
