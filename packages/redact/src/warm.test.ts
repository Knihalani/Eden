import { describe, expect, test } from "bun:test";
import { gateOf, rulesWith, GATE_ENGINES } from "./secrets";
import { sanitizeForStore, secretRules, warmGate } from "./index";

// Secret-shaped values are assembled from parts so no literal in the repo is one (packages/redact/CLAUDE.md).
const token = "gh" + "p_" + "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5";

describe("warmGate", () => {
  test("after it, the first gate call on keyword-bearing text is fast", () => {
    warmGate();
    // Words that reach many rules' prefilters, none seen before in this process by the gate's own warm-up.
    const text = "heroku twilio sendgrid gitlab npm pypi stripe slack jwt bearer access key password for the deploy";
    const started = performance.now();
    sanitizeForStore(text);
    // Cold, the same call compiles the rules it reaches: 36-44 ms measured; warm, 1.0-1.8 ms.
    expect(performance.now() - started).toBeLessThan(5);
  });

  test("a second call is a no-op", () => {
    warmGate();
    const rules = secretRules();
    const started = performance.now();
    warmGate();
    expect(performance.now() - started).toBeLessThan(1);
    // The rule set is not rebuilt.
    expect(secretRules()).toBe(rules);
  });

  test("warming does not change what the gate finds", () => {
    warmGate();
    const text = `deploy with token ${token} and password=hunter2hunter2 to prod`;
    const cold = gateOf(rulesWith(GATE_ENGINES));
    expect(sanitizeForStore(text)).toBe(cold.sanitizeForStore(text));
    expect(sanitizeForStore(text)).not.toContain(token);
  });

  test("every rule with deferred work can be warmed on its own", () => {
    const rules = rulesWith(GATE_ENGINES);
    const warmable = rules.filter((rule) => rule.warm);
    expect(warmable.length).toBeGreaterThan(100);
    for (const rule of warmable) rule.warm!();
  });
});
