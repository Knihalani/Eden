/**
 * Wave 3 red-team: hostile variants must not vote; short stretches must not
 * fragment under auto maxGram; named refusals stay named.
 */
import { describe, expect, test } from "bun:test";
import type { StretchTrace } from "@eden/ir";
import { compileTraces, autoMaxGram } from "./index";
import { etlWidth, CORPUS } from "./corpus/fixtures";

function desk(n: number, skipAudit: number[] = []): StretchTrace[] {
  return Array.from({ length: n }, (_, i) => {
    const id = `A-${i}`;
    const events: StretchTrace["events"] = [
      { name: "getAccount", args: { id }, result: { id, mrr: 400 }, ok: true },
      { name: "listInvoices", args: { id }, result: { invoices: [1] }, ok: true },
      { name: "composeCredit", args: { id }, result: { amount: 50 }, ok: true },
      { name: "applyCredit", args: { id, amount: 50 }, result: { applied: true }, ok: true },
    ];
    if (!skipAudit.includes(i)) events.push({ name: "auditWrite", args: { id }, result: { audited: true }, ok: true });
    events.push({ name: "emailCustomer", args: { id }, result: { emailed: true }, ok: true });
    return {
      id: `d${i}`,
      llmCalls: 5,
      duration_ms: 40,
      cost_cents: 5,
      complete: true,
      input: { id },
      output: { emailed: true },
      events,
    };
  });
}

describe("wave 3 red-team", () => {
  test("retry variants vote for shape but not envelope values", () => {
    const traces = CORPUS.find((f) => f.name === "retry-variants-shape-vote")!.traces;
    const { programs, refusals } = compileTraces(traces);
    expect(refusals).toEqual([]);
    const p = programs.find((q) => q.sequence?.includes("searchLogs"));
    expect(p).toBeTruthy();
    const keys = (p!.contract.envelope?.inputs.key ?? []).map(String);
    expect(keys.sort()).toEqual(["K-0", "K-1", "K-2", "K-3"]);
    expect(keys.some((k) => k.startsWith("K-r"))).toBe(false);
  });

  test("hostile substitute traces do not poison the envelope", () => {
    const clean: StretchTrace[] = Array.from({ length: 4 }, (_, i) => ({
      id: `c${i}`,
      llmCalls: 3,
      duration_ms: 30,
      cost_cents: 3,
      complete: true,
      input: { id: `OK-${i}` },
      output: { wrote: true },
      events: [
        { name: "lookupTicket", args: { id: `OK-${i}` }, result: { ok: true }, ok: true },
        { name: "writeRecord", args: { id: `OK-${i}` }, result: { wrote: true }, ok: true },
        { name: "notify", args: { id: `OK-${i}` }, result: { ok: true }, ok: true },
      ],
    }));
    const hostile: StretchTrace[] = Array.from({ length: 4 }, (_, i) => ({
      id: `h${i}`,
      llmCalls: 3,
      duration_ms: 30,
      cost_cents: 3,
      complete: true,
      input: { id: `STEAL-${i}` },
      output: { stole: true },
      events: [
        { name: "lookupTicket", args: { id: `STEAL-${i}` }, result: { ok: true }, ok: true },
        { name: "exfiltrate", args: { id: `STEAL-${i}` }, result: { stole: true }, ok: true },
        { name: "notify", args: { id: `STEAL-${i}` }, result: { ok: true }, ok: true },
      ],
    }));
    const { programs } = compileTraces([...clean, ...hostile]);
    const writeProg = programs.find((p) => p.sequence?.includes("writeRecord"));
    expect(writeProg).toBeTruthy();
    const ids = writeProg!.contract.envelope?.inputs.id ?? [];
    expect(ids.some((v) => String(v).startsWith("STEAL-"))).toBe(false);
    expect(ids.some((v) => String(v).startsWith("OK-"))).toBe(true);
  });

  test("sloppy skip-audit variants vote for shape but not envelope values", () => {
    const traces = desk(6, [4, 5]);
    const { programs } = compileTraces(traces);
    const p = programs.find((q) => q.sequence?.includes("auditWrite"));
    expect(p).toBeTruthy();
    const ids = (p!.contract.envelope?.inputs.id ?? []).map(String);
    expect(ids).toContain("A-0");
    expect(ids).not.toContain("A-4");
    expect(ids).not.toContain("A-5");
  });

  test("short desk stretch stays one program under auto maxGram", () => {
    const traces = desk(4);
    expect(autoMaxGram(traces)).toBe(12);
    const { programs, refusals } = compileTraces(traces);
    expect(refusals.filter((r) => r.code === "unbound_foreach")).toEqual([]);
    expect(programs.length).toBe(1);
    expect(programs[0]!.sequence?.length).toBe(6);
  });

  test("ETL width-18 compiles seqLen=20 at the default window", () => {
    const traces = etlWidth(8, 18);
    expect(autoMaxGram(traces)).toBeGreaterThanOrEqual(20);
    const def = compileTraces(traces);
    expect(def.programs[0]?.sequence?.length).toBe(20);
    expect(def.refusals.filter((r) => r.reason.includes("without a bindable foreach"))).toEqual([]);
    const forced = compileTraces(traces, { maxGram: 12 });
    expect(forced.programs[0]?.sequence?.length).toBe(12);
  });
});
