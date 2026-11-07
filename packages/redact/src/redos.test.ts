/**
 * D24 and D86: no input makes the gate super-linear. The timing half of linear.test.ts, in files of its own so a
 * parallel test run (`scripts/test.sh`) runs it beside the equivalence checks instead of after them. Secret-shaped
 * values are assembled from parts, so no literal in this file is one.
 */
import { describe, expect, test } from "bun:test";
import { backtrackingEngine, linearEngine, RE2_RULES, rulesWith, sanitizeForStore, secretRules } from "./secrets";
import { CEILING_MS, costMs, craftedInputs, SHARDS, shardRules, slowOn } from "./redos-sweep";

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

  test("the sweep's cost (the lesser of wall and CPU time) still flags a rule that backtracks", () => {
    // curl-auth-header is on RE2 because JavaScript's engine backtracks on it: about 78 ms on its "curl:" run here,
    // on either clock (the cheapest of the seven to show; with every rule on JavaScript the sweep flags all seven).
    const js = rulesWith({ rule: () => backtrackingEngine, allowlist: linearEngine });
    const rule = js.find((r) => r.id === "curl-auth-header")!;
    expect(RE2_RULES.has(rule.id)).toBe(true);
    // Twice the crafted run: backtracking is super-linear, so on a fast CPU the single run read 35-39 ms, under the
    // ceiling (RealUse-1 fix sessions); doubled it stays well above it while the linear engine stays far below.
    const text = [...craftedInputs(rule)].find((t) => t.startsWith("curl:curl:"))!.repeat(2);
    expect(costMs(() => rule.spans(text))).toBeGreaterThan(CEILING_MS);
  });
});

describe("no input makes the gate super-linear", () => {
  // D220's presigned value: one value of 1 MB made of `%` or `%2` (a `%` that never starts `%26`). An unrolled loop
  // over `%` made JavaScriptCore keep state per `%`: 215 ms at 1 MB, and past that it gave up and matched nothing,
  // so the value was stored in clear (the review). The value must stay redacted, in linear time.
  for (const unit of ["%", "%2"]) {
    test(`a 1 MB presigned value of ${JSON.stringify(unit)} is redacted in linear time`, () => {
      const text = `get https://b/q?${"X-Amz-" + "Signature="}${unit.repeat(Math.ceil(1_048_576 / unit.length))} now`;
      const t0 = performance.now();
      const out = sanitizeForStore(text);
      expect(performance.now() - t0).toBeLessThan(1_000);
      expect(out).toBe("get https://b/q?X-Amz-Signature=[REDACTED] now");
    });
  }

  // Each took 2-9 s at 128 KB before D24 (docs/research/architecture-alternatives.md); now a few milliseconds.
  const attacks: [string, string][] = [
    ["sumologic-access-id", "sumox-"],
    ["okta-access-token", "okta0"],
    ["curl-auth-user", "curl "],
    ["curl-auth-header", "curl="],
    ["eden-url-userinfo", "a-"],
    // Every token a candidate (40 base64 characters, mixed case, an anchor beside it): one pass each (D86).
    ["eden-aws-secret", `secret ${"aB3dE5gH7jK9mN2pQ4sT"}+${"6vW8yZaB3dE5gH7jK9m"} `],
    // D220's rules: every prefix a candidate, and runs that stop one short of the length or start the next match.
    ["eden-new-relic", "NRAK-ABCDEFGHIJKLMNOPQRSTUVWXYZ "],
    ["eden-presigned-url", "&X-Amz-Signature=0123456789abcde&"],
    ["eden-presigned-url", "?x-goog-signature="],
    ["eden-presigned-url", "%26X-Amz-Signature%3D0123456789abcd%26"],
    ["eden-presigned-url", "\\u0026x-amz-security-token="],
  ];
  for (const [rule, unit] of attacks) {
    test(`128 KB built against ${rule}: ${JSON.stringify(unit.slice(0, 20))}`, () => {
      const text = unit.repeat(Math.ceil(131_072 / unit.length)) + (rule === "eden-url-userinfo" ? "://" : "");
      const t0 = performance.now();
      sanitizeForStore(text);
      expect(performance.now() - t0).toBeLessThan(1_000);
    });
  }
});
