/** D1850: `byStart` is the stable comparator sort it replaces, span object for span object. */
import { describe, expect, test } from "bun:test";
import { byStart } from "./compose.ts";
import { prng } from "./differential.ts";

describe("byStart", () => {
  test("gives what a stable sort by start gives, on 5,000 random lists (sorted runs, ties, reversed)", () => {
    const rnd = prng(1850);
    for (let t = 0; t < 5_000; t++) {
      const spans: [number, number][] = [];
      for (let n = Math.floor(rnd() * 60); n > 0; n--) {
        const start = Math.floor(rnd() * 20);
        spans.push([start, start + Math.floor(rnd() * 5)]);
      }
      if (rnd() < 0.3) spans.sort((a, b) => a[0] - b[0]);
      if (rnd() < 0.2) spans.reverse();
      const expected = [...spans].sort((a, b) => a[0] - b[0]);
      const got = byStart([...spans]);
      expect(got.length).toBe(expected.length);
      for (let i = 0; i < got.length; i++) if (got[i] !== expected[i]) throw new Error(JSON.stringify(spans));
    }
  });
});
