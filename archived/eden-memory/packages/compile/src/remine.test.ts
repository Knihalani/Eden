/**
 * Bounded remine cache: a second compileTraces on the same (traces+opts) is
 * near-free, and a different batch never gets a stale program.
 */
import { describe, expect, test } from "bun:test";
import { compileTraces } from "./index";
import { CORPUS, etlWidth } from "./corpus/fixtures";
import type { StretchTrace } from "@eden/ir";

function desk(n: number): StretchTrace[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `d${i}`,
    llmCalls: 6,
    duration_ms: 40,
    cost_cents: 4,
    complete: true,
    input: { id: `A-${i}` },
    output: { emailed: true },
    events: [
      { name: "getAccount", args: { id: `A-${i}` }, result: { id: `A-${i}` }, ok: true },
      { name: "listInvoices", args: { id: `A-${i}` }, result: { invoices: [1, 2] }, ok: true },
      { name: "composeCredit", args: { id: `A-${i}` }, result: { amount: 50 }, ok: true },
      { name: "applyCredit", args: { id: `A-${i}`, amount: 50 }, result: { applied: true }, ok: true },
      { name: "auditWrite", args: { id: `A-${i}` }, result: { audited: true }, ok: true },
      { name: "emailCustomer", args: { id: `A-${i}` }, result: { emailed: true }, ok: true },
    ],
  }));
}

describe("remine cache", () => {
  test("second compileTraces on the same batch is near-free", () => {
    const traces = etlWidth(40, 12);
    const t0 = performance.now();
    const first = compileTraces(traces);
    const firstMs = performance.now() - t0;
    expect(first.programs.length).toBeGreaterThan(0);
    const t1 = performance.now();
    const second = compileTraces(traces);
    const secondMs = performance.now() - t1;
    expect(second.programs.map((p) => p.id)).toEqual(first.programs.map((p) => p.id));
    expect(second.programs.map((p) => p.version)).toEqual(first.programs.map((p) => p.version));
    expect(secondMs).toBeLessThan(25);
    expect(secondMs).toBeLessThan(Math.max(5, firstMs / 8));
  });

  test("does not return stale programs if traces differ (new array)", () => {
    const a = desk(4);
    const unique = CORPUS.find((f) => f.name === "unique-work-crm")!.traces;
    const compiled = compileTraces(a);
    expect(compiled.programs.length).toBe(1);
    const empty = compileTraces(unique);
    expect(empty.programs.length).toBe(0);
    expect(empty.refusals.length).toBe(0);
  });

  test("does not return stale programs if the same array is mutated", () => {
    const traces: StretchTrace[] = desk(4);
    const first = compileTraces(traces);
    expect(first.programs.length).toBe(1);
    traces.length = 0;
    traces.push(...CORPUS.find((f) => f.name === "unique-work-crm")!.traces);
    const second = compileTraces(traces);
    expect(second.programs.length).toBe(0);
  });

  test("different opts on the same batch do not share a cached program", () => {
    const traces = etlWidth(8, 18);
    const def = compileTraces(traces);
    const forced = compileTraces(traces, { maxGram: 12 });
    expect(def.programs[0]?.sequence?.length).toBe(20);
    expect(forced.programs[0]?.sequence?.length).toBe(12);
  });

  test("named: homogeneous ETL still mines seqLen 20 when shape clustering already covers the batch", () => {
    const traces = etlWidth(12, 18);
    const r = compileTraces(traces);
    expect(r.programs.length).toBe(1);
    expect(r.programs[0]?.sequence?.length).toBe(20);
    expect(r.refusals.filter((x) => x.reason.includes("without a bindable foreach"))).toHaveLength(0);
  });
});
