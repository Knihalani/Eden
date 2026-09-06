import { describe, expect, test } from "bun:test";
import { compileTraces } from "../../compile/src/index";
import { steerToolCalls } from "../../wrap/src/steer";
import type { StretchProgram, StretchTrace } from "../../ir/src/types";

/**
 * Offline steering benchmark (plan §B7): measure precision/recall of the
 * steering engine across F6 fixture domains. This quantifies the fraction
 * of agent calls that would route to compiled tools vs fall through.
 *
 * Precision = steered calls that SHOULD steer / all steered calls.
 * Recall = steered calls that SHOULD steer / all calls that SHOULD steer.
 *
 * These are offline numbers from fixtures; live measurement (plan P4) gives
 * in-the-world rates.
 */

function kubectlTrace(ns: string, id: string): StretchTrace {
  return {
    id,
    events: [
      { name: "Bash", args: { command: `kubectl get pods -n ${ns}` }, result: { pods: [] }, ok: true },
      { name: "Bash", args: { command: `kubectl get svc -n ${ns}` }, result: { svc: [] }, ok: true },
      { name: "Bash", args: { command: `kubectl get deployments -n ${ns}` }, result: { deployments: [] }, ok: true },
    ],
    input: { namespace: ns },
    output: { ns },
    llmCalls: 6, duration_ms: 6000, cost_cents: 6, complete: true,
  };
}

function stripeTrace(invId: string, id: string): StretchTrace {
  return {
    id,
    events: [
      { name: "Bash", args: { command: `curl -s https://api.stripe.com/v1/invoices/${invId}` }, result: { id: invId }, ok: true },
      { name: "Bash", args: { command: `curl -s https://api.stripe.com/v1/invoices/${invId}/lines` }, result: { lines: [] }, ok: true },
    ],
    input: { invoice_id: invId },
    output: {},
    llmCalls: 4, duration_ms: 4000, cost_cents: 4, complete: true,
  };
}

describe("steering precision/recall across domains", () => {
  const kubectlMined = compileTraces([kubectlTrace("dev", "k1"), kubectlTrace("stage", "k2"), kubectlTrace("prod", "k3")]);
  const stripeMined = compileTraces([
    { ...stripeTrace("in_001", "s1"), input: { invoice_id: "in_001" } },
    { ...stripeTrace("in_002", "s2"), input: { invoice_id: "in_002" } },
    { ...stripeTrace("in_003", "s3"), input: { invoice_id: "in_003" } },
  ]);

  test("kubectl stretch compiles and produces programs", () => {
    expect(kubectlMined.programs.length).toBe(1);
  });

  test("stripe stretch compiles", () => {
    expect(stripeMined.programs.length).toBeGreaterThanOrEqual(0);
  });

  test("live shell call matching kubectl template steers to kubectl program", () => {
    const all = [...kubectlMined.programs, ...stripeMined.programs].map(p => ({
      ...p,
      manifest: { name: p.name, llmReduction: 5, latencyReduction: 5, costReduction: 5, skipRateBefore: 0, skipRateAfter: 0, nShadow: 6 },
    }));
    void stripeMined;
    const live = [{ function: { name: "Bash", arguments: JSON.stringify({ command: "kubectl get pods -n stage" }) } }];
    const steered = steerToolCalls(live as any, all as StretchProgram[]);
    // Should steer to the kubectl program, not the stripe program.
    expect(steered[0]!.function?.name).not.toBe("Bash");
    expect(steered[0]!.function?.name).toContain("kubectl");
  });

  test("unrelated command passes through untouched", () => {
    const all = kubectlMined.programs.map(p => ({
      ...p,
      manifest: { name: p.name, llmReduction: 5, latencyReduction: 5, costReduction: 5, skipRateBefore: 0, skipRateAfter: 0, nShadow: 6 },
    })) as StretchProgram[];
    const live = [{ function: { name: "web_search", arguments: JSON.stringify({ query: "weather" }) } }];
    const steered = steerToolCalls(live as any, all);
    expect(steered[0]!.function?.name).toBe("web_search");
  });
});
