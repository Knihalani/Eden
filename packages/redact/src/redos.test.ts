/**
 * D24 and D86: no input makes the gate super-linear. The timing half of linear.test.ts, in files of its own so a
 * parallel test run (`scripts/test.sh`) runs it beside the equivalence checks instead of after them. Secret-shaped
 * values are assembled from parts, so no literal in this file is one.
 */
import { describe, expect, test } from "bun:test";
import { RE2_RULES, sanitizeForStore, secretRules } from "./secrets";
import { SHARDS, shardRules, slowOn } from "./redos-sweep";

// The crafted-input sweep is split by rule index over this file (shard 0) and redos-{1,2,3}.test.ts (redos-sweep.ts).
describe("rules left on JavaScript's engine stay cheap on crafted input", () => {
  test("shard 0 of every gitleaks rule outside RE2_RULES, and every Eden rule", () => {
    expect(shardRules(0).length).toBeGreaterThan(0);
    expect(slowOn(0)).toEqual([]);
  }, 60_000);

  test("the shards together are every rule on JavaScript's engine, each once", () => {
    const ids = Array.from({ length: SHARDS }, (_, k) => shardRules(k).map((r) => r.id)).flat();
    const all = secretRules()
      .filter((rule) => !RE2_RULES.has(rule.id))
      .map((r) => r.id);
    expect(ids.sort()).toEqual(all.sort());
  });
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
