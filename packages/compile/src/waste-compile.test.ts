/**
 * Wave 12.3: desk-shaped repeating uncompiled work ranked #1 by wasted
 * tokens compiles into a certified PASS candidate. Unique-work stays empty.
 * Not a retune of cert-rate.
 */
import { describe, expect, test } from "bun:test";
import type { StretchTrace } from "@eden/ir";
import { activityFromInbox, inboxItems } from "../../../apps/web/app/home/activity";
import { rankByWaste } from "../../measure/src/novelty";
import { registryFrom } from "../../runtime/src/registry";
import { canApprove, shadowProgram } from "../../shadow/src/index";
import { compileTraces } from "./compile";
import { underdeterminedSiblingTraces } from "../../runtime/src/ticketship";

function deskWaste(n: number, prompt: number, completion: number): StretchTrace[] {
  return Array.from({ length: n }, (_, i) => {
    const id = `A-${i}`;
    const events: StretchTrace["events"] = [
      { name: "getAccount", args: { id }, result: { id, mrr: 400 }, ok: true, duration_ms: 100 },
      { name: "listInvoices", args: { id }, result: { invoices: [1] }, ok: true, duration_ms: 100 },
      { name: "composeCredit", args: { id }, result: { amount: 50 }, ok: true, duration_ms: 5_000 },
      { name: "applyCredit", args: { id, amount: 50 }, result: { applied: true }, ok: true, duration_ms: 100 },
      { name: "auditWrite", args: { id }, result: { audited: true }, ok: true, duration_ms: 100 },
      { name: "emailCustomer", args: { id }, result: { emailed: true }, ok: true, duration_ms: 100 },
    ];
    return {
      id: `d${i}`,
      llmCalls: 5,
      duration_ms: events.reduce((a, e) => a + (e.duration_ms ?? 0), 0),
      cost_cents: 5,
      complete: true,
      input: { id },
      output: { emailed: true },
      prompt_tokens: prompt,
      completion_tokens: completion,
      events,
    };
  });
}

function uniqueWorkWaste(n: number, prompt: number, completion: number): StretchTrace[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `u${i}`,
    llmCalls: 3,
    duration_ms: 30,
    cost_cents: 3,
    complete: true,
    input: { id: `x${i}` },
    output: { ok: true },
    prompt_tokens: prompt,
    completion_tokens: completion,
    events: [
      { name: `toolA${i}`, args: { id: `x${i}` }, result: { ok: true }, ok: true },
      { name: `toolB${i}`, args: { id: `x${i}` }, result: { ok: true }, ok: true },
      { name: `toolC${i}`, args: { id: `x${i}` }, result: { ok: true }, ok: true },
    ],
  }));
}

function wasteOf(traces: StretchTrace[]): number {
  return traces.reduce((sum, t) => sum + (t.prompt_tokens ?? 0) + (t.completion_tokens ?? 0), 0);
}

describe("wave 12.3 waste compile", () => {
  test("unmeasured refusal stamps wastedTokens 0 — does not invent", () => {
    const { programs, refusals } = compileTraces(underdeterminedSiblingTraces(3));
    expect(programs).toEqual([]);
    expect(refusals.length).toBeGreaterThanOrEqual(1);
    expect(refusals[0]!.wastedTokens).toBe(0);
  });

  test("measured refusal sums provider prompt+completion on the cluster", () => {
    const traces = underdeterminedSiblingTraces(3).map((t, i) => ({
      ...t,
      prompt_tokens: 100 + i,
      completion_tokens: 20,
    }));
    const { refusals } = compileTraces(traces);
    expect(refusals.length).toBeGreaterThanOrEqual(1);
    expect(refusals[0]!.wastedTokens).toBe(100 + 101 + 102 + 20 * 3);
  });

  test("unique-work with huge tokens still compiles nothing and ranks empty", () => {
    const traces = uniqueWorkWaste(5, 8_000, 2_000);
    const { programs, refusals } = compileTraces(traces);
    expect(programs).toEqual([]);
    expect(refusals).toEqual([]);
    expect(rankByWaste(refusals)).toEqual([]);
    expect(
      inboxItems(
        activityFromInbox({
          candidates: [
            ...programs.map((p) => ({ id: p.id, program: p, verdict: "PASS", created_at: 1 })),
            ...refusals.map((r, i) => ({ id: `uw${i}`, sequence: r.sequence, verdict: "FAIL", created_at: 1, refusal: r })),
          ],
        }),
      ),
    ).toEqual([]);
  });

  test("desk-shaped #1 waste pattern compiles to a certified PASS candidate", async () => {
    const desk = deskWaste(4, 800, 200);
    const cheap = underdeterminedSiblingTraces(3).map((t) => ({
      ...t,
      prompt_tokens: 10,
      completion_tokens: 5,
    }));
    const unique = uniqueWorkWaste(5, 9_000, 1_000);

    const uniqueOut = compileTraces(unique);
    expect(uniqueOut.programs).toEqual([]);
    expect(uniqueOut.refusals).toEqual([]);

    const cheapOut = compileTraces(cheap);
    expect(cheapOut.programs).toEqual([]);
    expect(cheapOut.refusals[0]!.wastedTokens).toBe(3 * (10 + 5));

    const deskOut = compileTraces(desk);
    expect(deskOut.refusals).toEqual([]);
    expect(deskOut.programs.length).toBe(1);
    const program = deskOut.programs[0]!;
    expect(program.sequence?.length).toBe(6);
    expect(program.wastedTokens).toBe(4 * (800 + 200));
    expect(wasteOf(desk)).toBe(program.wastedTokens);

    const uniqueInbox = activityFromInbox({ candidates: [] });
    expect(inboxItems(uniqueInbox)).toEqual([]);

    const cheapRefusal = cheapOut.refusals[0]!;
    const activity = activityFromInbox({
      candidates: [
        {
          id: "cheap",
          program: { name: "cheap" },
          verdict: "FAIL",
          created_at: 99,
          refusal: cheapRefusal,
        },
        {
          id: program.id,
          program,
          verdict: "PASS",
          created_at: 1,
        },
      ],
    });
    const items = inboxItems(activity);
    expect(items.map((item) => [item.id, item.name, item.status])).toEqual([
      [`request:${program.id}`, program.name, "Ready"],
      ["request:cheap", "cheap", "Unbound write"],
    ]);
    expect(activity.requests.find((item) => item.id === program.id)?.wastedTokens).toBe(4_000);
    expect(activity.requests.find((item) => item.id === "cheap")?.wastedTokens).toBe(45);
    expect(items[0]?.name).toBe(program.name);

    const registry = registryFrom({
      getAccount: (args) => ({ id: args.id, mrr: 400 }),
      listInvoices: () => ({ invoices: [1] }),
      applyCredit: () => ({ applied: true }),
      auditWrite: () => ({ audited: true }),
      emailCustomer: () => ({ emailed: true }),
    });
    const result = await shadowProgram(program, desk, {
      registry,
      registryFor: () => registry,
      island: async () => ({ amount: 50 }),
      allowSideEffects: true,
    });
    expect(result.verdict).toBe("PASS");
    expect(result.manifest?.certified).toBe(true);
    expect(canApprove(result)).toBe(true);
  });
});
