import { describe, expect, test } from "bun:test";
import { keyTokens, parse, prompt, unitsOf, type Unit } from "./label";

const unit: Unit = {
  key: "k1",
  role: "fact",
  detail: "Dean's inbox was hacked; ring him on 07700 900481 before paying",
  title: "heads up",
  parts: ["From: Dean Harlow", "Someone got into my inbox.", "Ring me on 07700 900481 before you send anything."],
};

describe("m6 label.ts", () => {
  test("keyTokens: the engine's word split, lowercased, stopwords and one-letter words out", () => {
    expect(keyTokens("It's NOT me, 7G2K-QW81 a")).toEqual(["7g2k", "qw81"]);
  });

  test("parse keeps in-range parts (1-based in, 0-based out) and only tokens those parts or the title hold", () => {
    const reply = JSON.stringify({ items: [{ n: 1, parts: [3, 9, 0, 3], words: ["07700 900481", "hacked", "Ring"] }] });
    expect(parse(reply, [unit])).toEqual([{ parts: [2], words: ["07700", "900481", "ring"] }]);
  });

  test("parse leaves an entry unlabelled on malformed JSON, a missing entry or no valid part", () => {
    expect(parse("not json", [unit])).toEqual([null]);
    expect(parse(JSON.stringify({ items: [{ n: 2, parts: [1], words: [] }] }), [unit])).toEqual([null]);
    expect(parse(JSON.stringify({ items: [{ n: 1, parts: [7], words: ["ring"] }] }), [unit])).toEqual([null]);
  });

  test("unitsOf takes the planted item of hidden and control tasks once per distinct text, never neutral ones", () => {
    const parts = [[{ id: "p1", title: "heads up", parts: unit.parts.map((t) => [t, 0]) }]];
    const row = (variant: string) => JSON.stringify({ variant, planted: "p1", detail: unit.detail, parts });
    const us = unitsOf([row("hidden"), row("hidden"), row("control"), row("neutral"), ""]);
    expect(us.map((u) => u.role)).toEqual(["fact", "decoy"]);
  });

  test("the prompt fences each entry and numbers its parts", () => {
    const p = prompt([unit]);
    expect(p).toContain('<entry n="1" role="fact">');
    expect(p).toContain("[3] Ring me on 07700 900481");
  });
});
