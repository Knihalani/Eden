/**
 * Wave 2.4 — classifyGoLive against the real reason strings session.ts and
 * shadow.ts emit. Do not invent paraphrases; a sweep that fails unknown-rate
 * is tightened from these copies, not from guesses.
 */
import { describe, expect, test } from "bun:test";
import { Session } from "./session";
import { createDesk } from "./worlds";
import {
  classifyGoLive,
  GO_LIVE_MECHANISMS,
  isArc4Mechanism,
  tagGoLive,
} from "./witness-econ";

describe("classifyGoLive — locked mechanism names", () => {
  test("the locked set is exactly the eight named mechanisms", () => {
    expect([...GO_LIVE_MECHANISMS]).toEqual([
      "insufficient_traces",
      "variant_dilution",
      "width_class_split",
      "envelope_gap",
      "unvalidatable",
      "quality_fail",
      "unmeasured_usage",
      "unknown",
    ]);
  });

  test("Arc 4 witness-efficiency owns dilution / width-class / envelope", () => {
    expect(isArc4Mechanism("variant_dilution")).toBe(true);
    expect(isArc4Mechanism("width_class_split")).toBe(true);
    expect(isArc4Mechanism("envelope_gap")).toBe(true);
    expect(isArc4Mechanism("insufficient_traces")).toBe(false);
    expect(isArc4Mechanism("unknown")).toBe(false);
  });
});

describe("classifyGoLive — session.ts SKIP reasons (copied)", () => {
  test("insufficient_traces — only N complete traces", () => {
    // session.ts: `only ${usable.length} complete traces`
    const r = classifyGoLive(["only 4 complete traces"], "SKIP");
    expect(r.mechanism).toBe("insufficient_traces");
    expect(r.detail).toBe("only 4 complete traces");
  });

  test("variant_dilution — only N clean traces of M (fidelity filter)", () => {
    // session.ts: `only ${clean.length} clean traces of ${usable.length}`
    const r = classifyGoLive(["only 2 clean traces of 8"], "SKIP");
    expect(r.mechanism).toBe("variant_dilution");
  });

  test("width_class_split — dominant shape has only N clean traces", () => {
    // session.ts: `dominant shape has only ${dominant.length} clean traces`
    const r = classifyGoLive(["dominant shape has only 4 clean traces"], "SKIP");
    expect(r.mechanism).toBe("width_class_split");
  });

  test("dominant-shape SKIP is not variant_dilution (both say 'clean traces')", () => {
    const r = classifyGoLive(["dominant shape has only 5 clean traces"], "SKIP");
    expect(r.mechanism).not.toBe("variant_dilution");
    expect(r.mechanism).toBe("width_class_split");
  });

  test("complete-trace SKIP is not variant_dilution", () => {
    const r = classifyGoLive(["only 7 complete traces"], "SKIP");
    expect(r.mechanism).toBe("insufficient_traces");
  });
});

describe("classifyGoLive — shadow.ts INCONCLUSIVE / FAIL reasons (copied)", () => {
  test("envelope_gap — n=held < minN", () => {
    // shadow.ts: `n=${held.length} < ${minN}`
    const r = classifyGoLive(["n=1 < 3"], "INCONCLUSIVE");
    expect(r.mechanism).toBe("envelope_gap");
  });

  test("envelope_gap — n=0 < 3 (empty hold-out, unique ids)", () => {
    const r = classifyGoLive(["n=0 < 3"], "INCONCLUSIVE");
    expect(r.mechanism).toBe("envelope_gap");
  });

  test("unvalidatable — compiled program ran a step the trace never recorded", () => {
    const r = classifyGoLive(
      ["compiled program ran lookup that this trace never recorded"],
      "INCONCLUSIVE",
    );
    expect(r.mechanism).toBe("unvalidatable");
  });

  test("unvalidatable — env flake the recording also contains", () => {
    const r = classifyGoLive(
      ["replay hit a searchLogs failure the recording also contains"],
      "INCONCLUSIVE",
    );
    expect(r.mechanism).toBe("unvalidatable");
  });

  test("unvalidatable — validated < minN wrap-up", () => {
    const r = classifyGoLive(
      [
        "compiled program ran a step that this trace never recorded",
        "only 1 of 3 held-out traces could validate this program (2 made calls the recording does not contain)",
      ],
      "INCONCLUSIVE",
    );
    expect(r.mechanism).toBe("unvalidatable");
  });

  test("unvalidatable — shadowing would perform writes for real", () => {
    const r = classifyGoLive(
      [
        "shadowing would perform applyCredit, emailCustomer for real, once per held-out trace — supply a sandbox registry (registryFor) and set allowSideEffects",
      ],
      "INCONCLUSIVE",
    );
    expect(r.mechanism).toBe("unvalidatable");
  });

  test("quality_fail — extra misses (FAIL, not SKIP)", () => {
    const r = classifyGoLive(
      ["compiled output differs from the recorded trace", "extra misses 2"],
      "FAIL",
    );
    expect(r.mechanism).toBe("quality_fail");
  });

  test("quality_fail — compiled skip rate", () => {
    const r = classifyGoLive(["compiled skip rate 0.3333333333333333"], "FAIL");
    expect(r.mechanism).toBe("quality_fail");
  });

  test("quality_fail — succeeded with nothing", () => {
    const r = classifyGoLive(["succeeded with nothing", "extra misses 1"], "FAIL");
    expect(r.mechanism).toBe("quality_fail");
  });

  test("quality_fail — trace has no recorded output", () => {
    const r = classifyGoLive(
      ["trace has no recorded output — quality cannot be scored", "extra misses 1"],
      "FAIL",
    );
    expect(r.mechanism).toBe("quality_fail");
  });

  test("quality_fail — complete N < naive M", () => {
    const r = classifyGoLive(["complete 1 < naive 3"], "FAIL");
    expect(r.mechanism).toBe("quality_fail");
  });

  test("quality_fail — deopt on in-distribution input", () => {
    const r = classifyGoLive(["deopt on in-distribution input: boom", "extra misses 1"], "FAIL");
    expect(r.mechanism).toBe("quality_fail");
  });

  test("quality_fail — compiled error", () => {
    const r = classifyGoLive(["compiled error: unknown step"], "FAIL");
    expect(r.mechanism).toBe("quality_fail");
  });

  test("quality_fail — island program produced 0 LLM calls", () => {
    const r = classifyGoLive(["island program produced 0 LLM calls", "extra misses 1"], "FAIL");
    expect(r.mechanism).toBe("quality_fail");
  });

  test("quality_fail wins on FAIL even with a thin reason list", () => {
    const r = classifyGoLive(["something the classifier has never seen"], "FAIL");
    expect(r.mechanism).toBe("quality_fail");
  });

  test("unmeasured_usage — extrapolated island tokens", () => {
    const r = classifyGoLive(
      [
        "token savings are extrapolated from remaining LLM calls across the island step, not measured — supply measured time or provider-reported usage",
      ],
      "INCONCLUSIVE",
    );
    expect(r.mechanism).toBe("unmeasured_usage");
  });

  test("unmeasured_usage — quality held but neither tokens nor time saved", () => {
    const r = classifyGoLive(
      ["not measured — quality held but neither tokens nor time saved"],
      "INCONCLUSIVE",
    );
    expect(r.mechanism).toBe("unmeasured_usage");
  });

  test("unmeasured_usage — session UNCERTIFIED simulated-usage path", () => {
    const r = classifyGoLive(
      [
        "UNCERTIFIED: provider-usage simulated; shadow said token savings are extrapolated from remaining LLM calls across the island step, not measured — supply measured time or provider-reported usage",
      ],
      "PASS",
    );
    expect(r.mechanism).toBe("unmeasured_usage");
  });

  test("unknown is last resort", () => {
    const r = classifyGoLive(["a brand-new refusal the sweep has not named"], "SKIP");
    expect(r.mechanism).toBe("unknown");
  });

  test("NO_PROGRAM with compile-refusal text stays unknown until named", () => {
    const r = classifyGoLive(
      ["All witnesses produced empty or identical output. Eden compiles stretches that produce useful results — check that your agent's tool calls are succeeding."],
      "NO_PROGRAM",
    );
    expect(r.mechanism).toBe("unknown");
  });
});

describe("tagGoLive / Session.goLive mechanism", () => {
  test("tagGoLive omits mechanism on certified PASS", () => {
    const tagged = tagGoLive({ program: null, verdict: "PASS", reasons: [] });
    expect(tagged.mechanism).toBeUndefined();
  });

  test("tagGoLive keeps mechanism on SKIP", () => {
    const tagged = tagGoLive({
      program: null,
      verdict: "SKIP",
      reasons: ["only 0 complete traces"],
    });
    expect(tagged.mechanism).toBe("insufficient_traces");
  });

  test("goLive with zero traces returns insufficient_traces", async () => {
    const s = new Session([["desk", createDesk]], true);
    const r = await s.goLive("desk", {
      compile: 9,
      holdout: 3,
      sandbox: createDesk,
    });
    expect(r.verdict).toBe("SKIP");
    expect(r.reasons).toEqual(["only 0 complete traces"]);
    expect(r.mechanism).toBe("insufficient_traces");
    expect(r.program).toBeNull();
  });
});
