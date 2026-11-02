/**
 * D24 and D86: no input makes the gate super-linear. The timing half of linear.test.ts, in a file of its own so a
 * parallel test run (`scripts/test.sh`) runs it beside the equivalence checks instead of after them. Secret-shaped
 * values are assembled from parts, so no literal in this file is one.
 */
import { describe, expect, test } from "bun:test";
import { RE2_RULES, sanitizeForStore, secretRules } from "./secrets";

describe("rules left on JavaScript's engine stay cheap on crafted input", () => {
  // A reduced form of the search that found RE2_RULES: each rule's first keyword, then runs of characters its classes
  // take, at 8 KB. Measured once: the rules left on JavaScript took at most 13 ms here, while with every rule on
  // JavaScript the seven slow ones took 81–755 ms (curl-*: ~80 ms; sumologic-, okta-, cohere-: 560–760 ms). So a
  // gitleaks update that adds a backtracking rule fails here; the ceiling leaves room for a GC pause.
  const UNITS = ["a", "0", "f", "-", ".", "_", " ", "=", "/", ":", "\n", "'", "@", "a-", "a.", "a ", "x-", "AKIA"];
  const CEILING_MS = 40;
  const SIZE = 8_192;

  test("every gitleaks rule outside RE2_RULES, and every Eden rule", () => {
    const rules = secretRules().filter((rule) => !RE2_RULES.has(rule.id));
    const slow: string[] = [];
    for (const rule of rules) {
      const word = rule.keywords[0] ?? rule.prefilter[0] ?? "";
      for (const unit of UNITS) {
        const run = unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
        const pairs = `${word}${unit}`.repeat(Math.ceil(SIZE / (word.length + unit.length)));
        for (const text of [`${word}=${run}!`, pairs, run + word]) {
          // Best of up to three: a backtracking rule is slow every time, a GC pause only once (the suite shares a
          // process with tests that build large heaps).
          let ms = Infinity;
          for (let attempt = 0; attempt < 3 && ms > CEILING_MS; attempt++) {
            const t0 = performance.now();
            rule.spans(text);
            ms = Math.min(ms, performance.now() - t0);
          }
          if (ms > CEILING_MS) slow.push(`${rule.id} on ${JSON.stringify(text.slice(0, 24))}…: ${ms.toFixed(0)} ms`);
        }
      }
    }
    expect(slow).toEqual([]);
  }, 60_000);
});

describe("no input makes the gate super-linear", () => {
  // Each took 2-9 s at 128 KB before D24 (docs/research/architecture-alternatives.md); now a few milliseconds.
  const attacks: [string, string][] = [
    ["sumologic-access-id", "sumox-"],
    ["okta-access-token", "okta0"],
    ["curl-auth-user", "curl "],
    ["curl-auth-header", "curl="],
    ["eden-url-userinfo", "a-"],
    // Every token a candidate (40 base64 characters, mixed case, an anchor beside it): one pass each (D86).
    ["eden-aws-secret", `secret ${"aB3dE5gH7jK9mN2pQ4sT"}+${"6vW8yZaB3dE5gH7jK9m"} `],
  ];
  for (const [rule, unit] of attacks) {
    test(`128 KB built against ${rule}`, () => {
      const text = unit.repeat(Math.ceil(131_072 / unit.length)) + (rule === "eden-url-userinfo" ? "://" : "");
      const t0 = performance.now();
      sanitizeForStore(text);
      expect(performance.now() - t0).toBeLessThan(1_000);
    });
  }
});
