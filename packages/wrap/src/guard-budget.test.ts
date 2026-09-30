import { describe, expect, test } from "bun:test";
import { decideGuard } from "./guard";
import { emptyRun } from "./types";
import type { StretchProgram } from "@eden/ir";

function program(id: string, budgetMs: number): StretchProgram {
  return {
    id,
    version: "v1",
    name: `tool_${id}`,
    description: "",
    sequence: ["a", "b"],
    inputSchema: { type: "object" },
    steps: [],
    returns: { kind: "literal", value: null },
    contract: { witnesses: 3, minLlmReduction: 2, allowExact: false },
    manifest: {
      llmReduction: 5,
      latencyReduction: null,
      costReduction: 1,
      skipRateBefore: 0,
      skipRateAfter: 0,
      nShadow: 3,
    },
    budget: { ms: budgetMs, llmCalls: 1, cents: 0 },
  };
}

function run() {
  const r = emptyRun();
  r.firstWarningAt = 0;
  r.t0 = 0;
  r.events.push({ name: "a", args: {}, ok: true });
  return r;
}

const timing = { opts: { timeoutMs: 20_000 }, now: 2_000 };

describe("budget guard", () => {
  test("no warning-level time pressure means no guard action", () => {
    const d = decideGuard({ name: "b", run: run(), live: [program("small", 4_000)], ...timing });
    expect(d).toBeNull();
  });

  test("no fitting program halts instead of steering one that will deopt", () => {
    const d = decideGuard({ name: "b", run: run(), live: [program("big", 50_000)], ...timing });
    expect(d?.action).toBe("halt");
    expect(d?.reason).toBe("budget");
  });

  test("the fitting program wins even when listed after one that does not fit", () => {
    const live = [program("big", 50_000), program("small", 4_000)];
    const d = decideGuard({ name: "b", run: run(), live, ...timing });
    expect(d?.action).toBe("steer");
    if (d?.action === "steer") expect(d.program.id).toBe("small");
  });

  test("unwarned actual llmCalls >= predicted llmCalls=2 halts with predicted-vs-actual detail", () => {
    const r = emptyRun();
    r.t0 = 0;
    r.llmCalls = 2;
    r.events.push({ name: "a", args: {}, ok: true });
    expect(r.firstWarningAt).toBeUndefined();
    const p = program("on", 4_000);
    p.budget = { ms: 4_000, llmCalls: 2, cents: 0 };
    const d = decideGuard({ name: "b", run: r, live: [p], ...timing });
    console.log(
      `unwarned spent action=${d?.action} reason=${d && "reason" in d ? d.reason : ""} detail=${d && "detail" in d ? d.detail : ""}`,
    );
    expect(d).toMatchObject({ action: "halt", reason: "budget", detail: "predicted llmCalls=2 actual=2" });
  });

  test("unwarned timeout-pressure does not halt", () => {
    const r = emptyRun();
    r.t0 = 0;
    r.events.push({ name: "a", args: {}, ok: true });
    expect(r.firstWarningAt).toBeUndefined();
    const d = decideGuard({ name: "b", run: r, live: [program("big", 50_000)], ...timing });
    expect(d).toBeNull();
  });
});
