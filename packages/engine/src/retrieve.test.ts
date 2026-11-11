import { describe, expect, test } from "bun:test";
import { rrfOrder } from "./retrieve";

describe("rrfOrder (pushRetrieve, D901)", () => {
  test("an empty second list leaves the lexical order unchanged", () => {
    expect(rrfOrder([["a", "b", "c"], []])).toEqual(["a", "b", "c"]);
  });

  test("an item both lists rank goes first; ties go to the lexical list", () => {
    // b: 1/62 + 1/61; a: 1/61; x: 1/62; c: 1/63.
    expect(
      rrfOrder([
        ["a", "b", "c"],
        ["b", "x"],
      ]),
    ).toEqual(["b", "a", "x", "c"]);
  });

  test("a retriever-only item at rank 1 outranks the lexical list's 16th", () => {
    const lex = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const out = rrfOrder([lex, ["new"]]);
    expect(out.indexOf("new")).toBe(1);
    expect(out.slice(0, 15)).toContain("new");
  });

  test("a repeated id counts once per list", () => {
    expect(rrfOrder([["a", "a", "b"], []])).toEqual(["a", "b"]);
  });
});
