/**
 * D1850 (the review of 2026-11-14): the gate never redacts less than main did before D1850 (`secrets.baseline.ts`,
 * frozen; `never-less.ts`). The reference oracle moves with the gate, so a detection change that loses a secret
 * passes the differential; this does not. Secret-shaped values are assembled from parts, so no literal in this file
 * is one. The fuzz at scale: `bun packages/redact/src/never-less.ts 250000 <seed>`.
 */
import { describe, expect, test } from "bun:test";
import { prng } from "./differential.ts";
import { CRAFTED_UNITS, crafted } from "./gate-crafted.ts";
import { chainText, gateText } from "./gate-differential.ts";
import { baselineMaskDiffers, fuzzNeverLess, lessThanBaseline } from "./never-less.ts";
import { sanitizeForStore } from "./secrets.ts";

/** The review's failing inputs: an auth scheme as a keyword's value, then another keyword assignment. */
const REVIEW = [
  `the token is Bea${"rer"} secret is correct${"horsebattery"}`,
  `my token is Bea${"rer"} pwd is sword${"fish99x"}`,
  `token is basic credential is 'correct ${"horse battery"}'`,
  `password is bearer\t passwd: BASIC   API key='OmxBOm${"GGLHFv"}`,
  `auth token=Bearer  credential = "S5caX${"4O"}`,
];

describe("never redacts less than main before D1850", () => {
  test("the review's chained keywords: every secret main redacted is redacted", () => {
    for (const text of REVIEW) expect([text, lessThanBaseline(text)]).toEqual([text, undefined]);
    expect(sanitizeForStore(REVIEW[0]!)).not.toContain("horsebattery");
    expect(sanitizeForStore(REVIEW[1]!)).not.toContain("fish99x");
    expect(sanitizeForStore(REVIEW[2]!)).not.toContain("horse battery");
  });

  test("4,000 fuzz and keyword-chain texts", () => {
    const result = fuzzNeverLess(4_000, 20261115);
    expect(result.failures.slice(0, 3)).toEqual([]);
  }, 60_000);

  test("the crafted inputs at 16 KB", () => {
    for (const [name, unit] of CRAFTED_UNITS)
      expect([name, lessThanBaseline(crafted(unit, 16_384))]).toEqual([name, undefined]);
  }, 60_000);

  test("the baseline's mask (structuralMask traced back) is what it stores, on fuzz and chain texts", () => {
    const rnd = prng(7);
    for (let i = 0; i < 2_000; i++) {
      const text = i % 2 === 0 ? gateText(rnd) : chainText(rnd);
      expect([text, baselineMaskDiffers(text)]).toEqual([text, undefined]);
    }
  }, 60_000);
});
