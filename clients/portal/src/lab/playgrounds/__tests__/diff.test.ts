import { describe, expect, it } from "vitest";

import { diffWords, type DiffSegment } from "../diff";

const join = (segs: DiffSegment[], kind: DiffSegment["kind"]) =>
  segs
    .filter((s) => s.kind === kind)
    .map((s) => s.text)
    .join("");

describe("diffWords", () => {
  it("returns a single same segment for identical strings", () => {
    expect(diffWords("hello world", "hello world")).toEqual([
      { text: "hello world", kind: "same" },
    ]);
  });

  it("returns empty for two empty strings", () => {
    expect(diffWords("", "")).toEqual([]);
  });

  it("marks whole string added/removed when one side is empty", () => {
    expect(diffWords("", "new text")).toEqual([{ text: "new text", kind: "added" }]);
    expect(diffWords("old text", "")).toEqual([{ text: "old text", kind: "removed" }]);
  });

  it("highlights a single word substitution", () => {
    const segs = diffWords("the quick brown fox", "the quick red fox");
    expect(join(segs, "removed")).toBe("brown");
    expect(join(segs, "added")).toBe("red");
    expect(join(segs, "same")).toContain("the quick");
    expect(join(segs, "same")).toContain("fox");
  });

  it("reconstructs both inputs losslessly (whitespace preserved)", () => {
    const base = "alpha  beta\n\tgamma";
    const cand = "alpha  delta\n\tgamma epsilon";
    const segs = diffWords(base, cand);
    const baseBack = segs
      .filter((s) => s.kind !== "added")
      .map((s) => s.text)
      .join("");
    const candBack = segs
      .filter((s) => s.kind !== "removed")
      .map((s) => s.text)
      .join("");
    expect(baseBack).toBe(base);
    expect(candBack).toBe(cand);
  });

  it("merges adjacent segments of the same kind", () => {
    const segs = diffWords("a b c", "x y z");
    // No two consecutive segments share a kind.
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].kind).not.toBe(segs[i - 1].kind);
    }
  });

  it("degrades to whole-string swap beyond the token cap", () => {
    const big = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(" ");
    const segs = diffWords(big, `${big} tail`);
    expect(segs).toEqual([
      { text: big, kind: "removed" },
      { text: `${big} tail`, kind: "added" },
    ]);
  });
});
