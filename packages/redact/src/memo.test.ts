/**
 * D1850 (the second review of 2026-11-14): the gate's memos last one call, so no caller's text outlives it. A memo
 * keyed by a slice of the text kept the whole text alive on JavaScriptCore: 60 distinct 1 MB texts left 56 MB on the
 * heap after a collection (main 0.1 MB). Secret-shaped values are assembled from parts.
 */
import { describe, expect, test } from "bun:test";
import { heapStats } from "bun:jsc";
import { Answers, Last, withMemos } from "./memo.ts";
import { gateOf, secretRules } from "./secrets.ts";

const rand = (n: number, seed: number) => {
  let s = "";
  let x = seed * 2654435761;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    s += "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[x % 62];
  }
  return s;
};

describe("memos last one call", () => {
  test("a memo answers inside an entry point, and holds nothing once it returns", () => {
    const last = new Last<number>();
    let computed = 0;
    const length = (key: string) => {
      computed++;
      return key.length;
    };
    expect(last.get("abc", length)).toBe(3);
    expect(last.get("abc", length)).toBe(3);
    expect(computed).toBe(2); // outside an entry point: no memo
    withMemos(() => {
      last.get("abcd", length);
      last.get("abcd", length);
      withMemos(() => last.get("abcd", length)); // nested: still the outer call's memo
    });
    expect(computed).toBe(3);
    expect(Object.values(last).includes("abcd")).toBe(false);
    const answers = new Answers<number>(2);
    withMemos(() => {
      for (const key of ["a", "bb", "a", "ccc", "a"]) answers.get(key, length);
    });
    expect(computed).toBe(7); // a, bb, ccc, and a again after the limit emptied the map
  });

  test("a memo is emptied when the entry point throws", () => {
    const last = new Last<number>();
    expect(() =>
      withMemos(() => {
        last.get("kept?", (key) => key.length);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    let computed = 0;
    withMemos(() => last.get("kept?", (key) => ++computed));
    expect(computed).toBe(1);
  });

  test("the retained heap stays flat over many large distinct texts with findings", () => {
    const gate = gateOf(secretRules());
    const run = (i: number) => {
      const text =
        "lorem ipsum dolor sit amet ".repeat(20_000) +
        i +
        ` ${"gh" + "p_"}${rand(36, i)} token=${rand(24, i + 1)} ${"AK" + "IA"}${rand(16, i + 2).toUpperCase()} ` +
        `password: ${rand(14, i + 3)} api_key = "${rand(30, i + 4)}" `;
      gate.sanitizeForStore(text);
      gate.secretHits(text);
      gate.findings(text);
    };
    run(0);
    Bun.gc(true);
    const before = heapStats().heapSize;
    for (let i = 1; i <= 30; i++) run(i);
    Bun.gc(true);
    // 30 texts of 540 KB each (16 MB) went through; main retained about 0.1 MB, the first version all of them.
    expect((heapStats().heapSize - before) / 1e6).toBeLessThan(4);
  }, 60_000);
});
