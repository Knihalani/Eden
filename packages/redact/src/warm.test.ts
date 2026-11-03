import { describe, expect, test } from "bun:test";
import { gateOf, rulesWith, GATE_ENGINES, type Engine, type EngineChoice } from "./secrets";
import { sanitizeForStore, secretRules, warmGate } from "./index";

// Secret-shaped values are assembled from parts so no literal in the repo is one (packages/redact/CLAUDE.md).
const token = "gh" + "p_" + "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5";

// Words that reach many rules' prefilters, none seen before in this process by the gate's own warm-up.
const keywords = "heroku twilio sendgrid gitlab npm pypi stripe slack jwt bearer access key password for the deploy";

/**
 * GATE_ENGINES with every compiled pattern counted, and every pattern's first run noted with the phase it fell in.
 * Cold, the first gate call on a text compiles the rules it reaches (36-44 ms measured, against 1.0-1.8 ms warm):
 * counting that work, rather than timing the call, holds on a loaded machine (a <5 ms bound failed under the
 * parallel gate, docs/TESTING.md).
 */
function countingEngines() {
  const work = { phase: "warm" as "warm" | "use", compiled: 0, firstRunInUse: 0, runsInUse: 0 };
  const counted =
    (engine: Engine): Engine =>
    (source) => {
      work.compiled++;
      const pattern = engine(source);
      let ran = false;
      const run = () => {
        if (work.phase === "use") {
          work.runsInUse++;
          if (!ran) work.firstRunInUse++;
        }
        ran = true;
      };
      return {
        test: (text) => (run(), pattern.test(text)),
        matches: (text) => (run(), pattern.matches(text)),
        groups: (text) => (run(), pattern.groups(text)),
      };
    };
  const choice: EngineChoice = {
    rule: (id) => counted(GATE_ENGINES.rule(id)),
    allowlist: counted(GATE_ENGINES.allowlist),
  };
  return { work, choice };
}

describe("warmGate", () => {
  test("after it, the first gate call on keyword-bearing text compiles nothing and runs no pattern cold", () => {
    // What warmGate does to the gate's own rules (rule.warm on each, then the gate), on rules whose engines count.
    const { work, choice } = countingEngines();
    const rules = rulesWith(choice);
    for (const rule of rules) rule.warm?.();
    const gate = gateOf(rules);
    const compiledByWarm = work.compiled;
    work.phase = "use";
    gate.sanitizeForStore(keywords);
    // The text did reach the rules' patterns (else the two checks below would hold vacuously)...
    expect(work.runsInUse).toBeGreaterThan(0);
    // ...and none was compiled, or run for its first time, on the request.
    expect(work.compiled).toBe(compiledByWarm);
    expect(work.firstRunInUse).toBe(0);

    // The control: without warming, the same call compiles patterns and runs them cold.
    const cold = countingEngines();
    const coldGate = gateOf(rulesWith(cold.choice));
    const compiledBefore = cold.work.compiled;
    cold.work.phase = "use";
    coldGate.sanitizeForStore(keywords);
    expect(cold.work.compiled).toBeGreaterThan(compiledBefore);
    expect(cold.work.firstRunInUse).toBeGreaterThan(0);

    // The module's own gate after warmGate gives the same answer.
    warmGate();
    expect(sanitizeForStore(keywords)).toBe(gate.sanitizeForStore(keywords));
  });

  test("a second call is a no-op", () => {
    warmGate();
    const rules = secretRules();
    // Count rule warm-ups during the second call: a no-op warms none.
    let warmed = 0;
    const originals = rules.map((rule) => rule.warm);
    rules.forEach((rule, i) => {
      if (originals[i]) rule.warm = () => (warmed++, originals[i]!());
    });
    try {
      warmGate();
    } finally {
      rules.forEach((rule, i) => {
        if (originals[i]) rule.warm = originals[i];
      });
    }
    expect(warmed).toBe(0);
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
