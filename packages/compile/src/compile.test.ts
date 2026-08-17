import { describe, expect, test } from "bun:test";
import type { StretchTrace } from "@eden/ir";
import { compileTraces, isCheckName, isIslandName, isMutating, tryTemplateForTest, oneInsert, oneSubstitute } from "../src/index";
import { createTicketShip, runNaive, ticketShipProgram, underdeterminedSiblingTraces, WITNESS_IDS } from "../../runtime/src/ticketship";

async function ticketTraces(n = 10): Promise<StretchTrace[]> {
  const traces: StretchTrace[] = [];
  for (let i = 0; i < n; i++) {
    const world = createTicketShip({ llmMs: 0 });
    const id = WITNESS_IDS[i % WITNESS_IDS.length]!;
      const run = await runNaive(world, id, { skipVerifyP: i % 5 === 0 ? 1 : 0, seed: 10 + i });
    traces.push({
      id: `t${i}`,
      events: run.events,
      input: { id },
      output: run.output,
      llmCalls: run.stats.llmCalls,
      duration_ms: 200 * run.stats.llmCalls,
      cost_cents: run.stats.cost_cents,
      skipped: run.stats.skipped,
      complete: run.stats.complete,
    });
  }
  return traces;
}

describe("compile", () => {
  test("mines TicketShip into an island + verify program", async () => {
    const traces = await ticketTraces(10);
    const { programs, refusals } = compileTraces(traces);
    expect(refusals).toEqual([]);
    expect(programs.length).toBe(1);
    const p = programs[0]!;
    expect(p.steps.some((s) => s.kind === "island")).toBe(true);
    expect(p.steps.some((s) => s.kind === "tool" && s.tool === "verifyWrite")).toBe(true);
    const verify = p.steps.find((s) => s.kind === "tool" && s.tool === "verifyWrite");
    expect(verify && verify.kind === "tool" && verify.args.id).toEqual({ kind: "input", path: "id" });
    expect(p.steps.some((s) => s.kind === "tool" && s.tool === "writeRecord")).toBe(true);
    expect(p.steps.some((s) => s.kind === "assert")).toBe(true);
    expect(p.sequence).toContain("draftReply");
    expect(p.contract.envelope?.inputs.id?.sort()).toEqual([...WITNESS_IDS].sort());
    const hand = ticketShipProgram();
    const compiledTools = p.steps.filter((s) => s.kind === "tool").map((s) => s.tool);
    const handTools = hand.steps.filter((s) => s.kind === "tool").map((s) => s.tool);
    expect(compiledTools).toEqual(handTools);
    expect(p.id).toMatch(/^p_[0-9a-f]{16}$/);
    expect(p.name).toBe("lookupTicket_to_notify");
    expect(p.contract.minLlmReduction).toBe(2);
    const again = compileTraces(traces).programs[0]!;
    expect(again.id).toBe(p.id);
  });

  test("skip-verify noise does not mint a second program without verifyWrite", async () => {
    const traces: StretchTrace[] = [];
    for (let i = 0; i < 12; i++) {
      const world = createTicketShip({ llmMs: 0 });
      const id = WITNESS_IDS[i % WITNESS_IDS.length]!;
      const run = await runNaive(world, id, { skipVerifyP: i < 5 ? 1 : 0, seed: 20 + i });
      traces.push({
        id: `sv${i}`,
        events: run.events,
        input: { id },
        llmCalls: run.stats.llmCalls,
        duration_ms: 200 * run.stats.llmCalls,
        cost_cents: run.stats.cost_cents,
        skipped: run.stats.skipped,
        complete: run.stats.complete,
      });
    }
    const { programs } = compileTraces(traces);
    expect(programs.length).toBe(1);
    expect(programs[0]!.sequence).toContain("verifyWrite");
    expect(programs[0]!.steps.some((s) => s.kind === "tool" && s.tool === "verifyWrite")).toBe(true);
  });

  test("refuses under-determined writeRecord.id sibling", () => {
    const { programs, refusals } = compileTraces(underdeterminedSiblingTraces(3));
    expect(programs).toEqual([]);
    expect(refusals.length).toBeGreaterThanOrEqual(1);
    expect(refusals[0]!.reason.toLowerCase()).toMatch(/under-determined|writeRecord/);
  });

  test("no repetition compiles nothing", () => {
    const traces: StretchTrace[] = Array.from({ length: 5 }, (_, i) => ({
      id: `u${i}`,
      llmCalls: 2,
      duration_ms: 10,
      cost_cents: 2,
      input: { id: `x${i}` },
      events: [
        { name: `toolA${i}`, args: { id: `x${i}` }, result: { ok: true }, ok: true },
        { name: `toolB${i}`, args: { id: `x${i}` }, result: { ok: true }, ok: true },
        { name: `toolC${i}`, args: { id: `x${i}` }, result: { ok: true }, ok: true },
      ],
    }));
    const { programs, refusals } = compileTraces(traces);
    expect(programs).toEqual([]);
    expect(refusals).toEqual([]);
  });

  test("identical copies do not count as separate witnesses", () => {
    const one: StretchTrace = {
      id: "u0",
      llmCalls: 3,
      duration_ms: 10,
      cost_cents: 3,
      input: { id: "T-100" },
      events: [
        { name: "lookupTicket", args: { id: "T-100" }, result: { ok: true }, ok: true },
        { name: "writeRecord", args: { id: "T-100" }, result: { written: true }, ok: true },
        { name: "verifyWrite", args: { id: "T-100" }, result: { verified: true }, ok: true },
      ],
    };
    const { programs, refusals } = compileTraces(Array.from({ length: 8 }, (_, i) => ({ ...one, id: `u${i}` })));
    expect(programs).toEqual([]);
    expect(refusals).toEqual([]);
  });

  test("92% trap refuses almost-constant mutating slot", () => {
    const traces: StretchTrace[] = Array.from({ length: 12 }, (_, i) => {
      const id = `T-${i}`;
      const dest = i === 0 ? "other-mailbox" : "ops@acme.test";
      return {
        id: `g${i}`,
        llmCalls: 3,
        duration_ms: 600,
        cost_cents: 3,
        input: { id },
        complete: true,
        events: [
          { name: "lookupTicket", args: { id }, result: { ok: true, id }, ok: true },
          { name: "fetchDetails", args: { id }, result: { id, body: "x" }, ok: true },
          { name: "notify", args: { id, to: dest }, result: { notified: true }, ok: true },
        ],
      };
    });
    const { programs, refusals } = compileTraces(traces);
    expect(programs).toEqual([]);
    expect(refusals.some((r) => /92%|under-determined|notify/i.test(r.reason))).toBe(true);
  });

  test("name heuristics", () => {
    expect(isIslandName("draftReply")).toBe(true);
    expect(isMutating("writeRecord")).toBe(true);
    expect(isMutating("notify")).toBe(true);
    expect(isMutating("poster")).toBe(false);
    expect(isCheckName("ensureWrite")).toBe(true);
    expect(isMutating("ensureWrite")).toBe(false);
  });

  test("compiles a stretch buried under extra prefix tools", async () => {
    const traces = await ticketTraces(8);
    for (const t of traces) {
      t.events = [
        { name: "Read", args: { path: "notes.md" }, result: { content: "x" }, ok: true },
        { name: "Bash", args: { command: "pwd" }, result: { code: 0 }, ok: true },
        ...t.events,
      ];
    }
    const { programs } = compileTraces(traces);
    expect(programs.length).toBeGreaterThanOrEqual(1);
    expect(programs[0]!.steps.some((s) => s.kind === "tool" && s.tool === "verifyWrite")).toBe(true);
  });

  test("hyphenated tool names bind from step ids", () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const id = `T-${100 + i}`;
      return {
        id: `h${i}`,
        llmCalls: 4,
        duration_ms: 800,
        cost_cents: 4,
        input: { id },
        complete: true,
        events: [
          { name: "lookup-ticket", args: { id }, result: { ok: true, id }, ok: true },
          { name: "fetch-details", args: { id }, result: { id, customer: `Ada-${i}` }, ok: true },
          { name: "write-record", args: { id, customer: `Ada-${i}` }, result: { wrote: true }, ok: true },
          { name: "verify-write", args: { id }, result: { verified: true }, ok: true },
        ],
      };
    });
    const { programs, refusals } = compileTraces(traces);
    expect(refusals).toEqual([]);
    const p = programs[0]!;
    const write = p.steps.find((s) => s.kind === "tool" && s.tool === "write-record");
    expect(write && write.kind === "tool").toBe(true);
    if (write && write.kind === "tool") {
      const customer = write.args.customer;
      expect(customer?.kind).toBe("from");
      if (customer?.kind === "from") expect(p.steps.some((s) => s.id === customer.step)).toBe(true);
    }
  });

  test("templates bind interpolated strings from input", () => {
    const traces: StretchTrace[] = [
      { id: "a", llmCalls: 1, duration_ms: 1, cost_cents: 1, input: { id: "T-100" }, events: [] },
      { id: "b", llmCalls: 1, duration_ms: 1, cost_cents: 1, input: { id: "T-101" }, events: [] },
    ];
    const tmpl = tryTemplateForTest(["hello T-100", "hello T-101"], traces, []);
    expect(tmpl).toEqual({
      kind: "transform",
      fn: "template",
      expr: "hello {id}",
      of: { kind: "input", path: "" },
    });
  });

  test("templates prefer the longest overlapping input string", () => {
    const traces: StretchTrace[] = [
      { id: "a", llmCalls: 1, duration_ms: 1, cost_cents: 1, input: { short: "T-1", id: "T-10" }, events: [] },
      { id: "b", llmCalls: 1, duration_ms: 1, cost_cents: 1, input: { short: "T-2", id: "T-20" }, events: [] },
    ];
    const tmpl = tryTemplateForTest(["hello T-10", "hello T-20"], traces, []);
    expect(tmpl && tmpl.kind === "transform" && tmpl.expr).toBe("hello {id}");
  });

  test("envelope treats key-reordered objects as one witness", () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => ({
      id: `e${i}`,
      llmCalls: 3,
      duration_ms: 30,
      cost_cents: 3,
      complete: true,
      input: {
        id: `T-10${i}`,
        record: i === 1 ? { b: 2, a: 1 } : { a: 1, b: 2 },
      },
      events: [
        { name: "lookupTicket", args: { id: `T-10${i}` }, result: { ok: true }, ok: true },
        { name: "writeRecord", args: { id: `T-10${i}`, record: i === 1 ? { b: 2, a: 1 } : { a: 1, b: 2 } }, result: { written: true }, ok: true },
        { name: "verifyWrite", args: { id: `T-10${i}` }, result: { verified: true }, ok: true },
      ],
    }));
    const { programs, refusals } = compileTraces(traces);
    expect(refusals).toEqual([]);
    expect(programs.length).toBe(1);
    expect(programs[0]!.contract.envelope?.inputs.record?.length).toBe(1);
  });

  test("mines a foreach loop over a prior array", () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const ids = [`a${i}`, `b${i}`, `c${i}`];
      return {
        id: `loop${i}`,
        llmCalls: 5,
        duration_ms: 1000,
        cost_cents: 5,
        input: { q: "open" },
        complete: true,
        events: [
          { name: "listItems", args: { q: "open" }, result: { ids }, ok: true },
          ...ids.map((id) => ({ name: "getItem", args: { id }, result: { id, ok: true }, ok: true })),
          { name: "notify", args: { q: "open" }, result: { notified: true }, ok: true },
        ],
      };
    });
    const { programs, refusals } = compileTraces(traces);
    expect(refusals).toEqual([]);
    const p = programs[0]!;
    expect(p.steps.some((s) => s.kind === "loop")).toBe(true);
    const loop = p.steps.find((s) => s.kind === "loop");
    expect(loop && loop.kind === "loop" && loop.body.length).toBe(1);
  });

  test("mines a period-2 loop over a prior array", () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const ids = [`a${i}`, `b${i}`, `c${i}`];
      return {
        id: `p${i}`,
        llmCalls: 8,
        duration_ms: 1000,
        cost_cents: 8,
        input: { q: "open" },
        complete: true,
        events: [
          { name: "listItems", args: { q: "open" }, result: { ids }, ok: true },
          ...ids.flatMap((id) => [
            { name: "getItem", args: { id }, result: { id, ok: true }, ok: true },
            { name: "tagItem", args: { id }, result: { tagged: true }, ok: true },
          ]),
          { name: "notify", args: { q: "open" }, result: { notified: true }, ok: true },
        ],
      };
    });
    const { programs, refusals } = compileTraces(traces);
    expect(refusals).toEqual([]);
    const p = programs[0]!;
    const loop = p.steps.find((s) => s.kind === "loop");
    expect(loop && loop.kind === "loop" && loop.body.length).toBe(2);
  });

  test("mines a nested loop when a period body itself repeats", () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const orgs = [`o${i}a`, `o${i}b`];
      return {
        id: `n${i}`,
        llmCalls: 10,
        duration_ms: 1000,
        cost_cents: 10,
        input: { q: "open" },
        complete: true,
        events: [
          { name: "listOrgs", args: { q: "open" }, result: { orgs }, ok: true },
          ...orgs.flatMap((org) => {
            const ids = [`${org}-1`, `${org}-2`];
            return [
              { name: "listItems", args: { id: org }, result: { ids }, ok: true },
              ...ids.map((id) => ({ name: "getItem", args: { id }, result: { id, org }, ok: true })),
            ];
          }),
          { name: "notify", args: { q: "open" }, result: { notified: true }, ok: true },
        ],
      };
    });
    const { programs, refusals } = compileTraces(traces);
    expect(refusals).toEqual([]);
    const p = programs[0]!;
    const outer = p.steps.find(
      (s) => s.kind === "loop" && s.body.some((id) => p.steps.some((x) => x.id === id && x.kind === "loop")),
    );
    expect(outer && outer.kind === "loop").toBe(true);
    const inner = p.steps.find((s) => s.kind === "loop" && s.id !== (outer && "id" in outer ? outer.id : ""));
    expect(inner && inner.kind === "loop" && inner.body.length).toBe(1);
  });

  test("keeps two sibling stretches that share a first tool", () => {
    const traces: StretchTrace[] = [];
    for (let i = 0; i < 3; i++) {
      traces.push({
        id: `a${i}`,
        llmCalls: 3,
        duration_ms: 30,
        cost_cents: 3,
        input: { id: `A-${i}` },
        events: [
          { name: "fetchRecord", args: { id: `A-${i}` }, result: { ok: true }, ok: true },
          { name: "tagItem", args: { id: `A-${i}` }, result: { ok: true }, ok: true },
          { name: "notify", args: { id: `A-${i}` }, result: { ok: true }, ok: true },
        ],
      });
      traces.push({
        id: `b${i}`,
        llmCalls: 3,
        duration_ms: 30,
        cost_cents: 3,
        input: { id: `B-${i}` },
        events: [
          { name: "fetchRecord", args: { id: `B-${i}` }, result: { ok: true }, ok: true },
          { name: "closeItem", args: { id: `B-${i}` }, result: { ok: true }, ok: true },
          { name: "notify", args: { id: `B-${i}` }, result: { ok: true }, ok: true },
        ],
      });
    }
    const { programs } = compileTraces(traces);
    expect(programs.length).toBe(2);
    // `sequence` is optional on StretchProgram for hand-written programs, but
    // compileTraces() always mines one.
    const seqs = programs.map((p) => p.sequence!.join(">")).sort();
    expect(seqs).toEqual(["fetchRecord>closeItem>notify", "fetchRecord>tagItem>notify"]);
  });

  test("refuses a slot whose agreed value hides a redacted credential", () => {
    // redact() rewrites credentials wherever they sit, so a header object can
    // agree perfectly across every witness while carrying only the sentinel.
    // Binding it as a literal would compile a tool that ships "[REDACTED]" to a
    // live API — the call fails, or worse, quietly succeeds unauthenticated.
    const traces: StretchTrace[] = [];
    for (let i = 0; i < 5; i++) {
      traces.push({
        id: `s${i}`,
        llmCalls: 3,
        duration_ms: 30,
        cost_cents: 3,
        input: { id: `R-${i}` },
        events: [
          { name: "fetchRecord", args: { id: `R-${i}` }, result: { id: `R-${i}`, ref: i }, ok: true },
          {
            name: "postUpdate",
            args: { id: `R-${i}`, headers: { authorization: "[REDACTED]" } },
            result: { ok: true },
            ok: true,
          },
          { name: "notify", args: { id: `R-${i}` }, result: { ok: true }, ok: true },
        ],
      });
    }
    const { programs, refusals } = compileTraces(traces);
    const literals = JSON.stringify(programs);
    expect(literals).not.toContain("[REDACTED]");
    expect(refusals.some((r) => /redacted secret slot/.test(r.reason))).toBe(true);
  });

  test("agreement ignores whether witnesses shared an object reference", () => {
    // Every witness passes the same `opts` value to the mutating step, but in
    // half of them it is the *same object* also referenced under `echo`. Two
    // deeply-equal arguments must stay indistinguishable end to end: redact()
    // has to expand the second reference rather than collapse it, and
    // canonicalize() has to hash it the same either way. If either stage is
    // reference-sensitive, these identical witnesses look like two distinct
    // values, the slot drops below exact agreement, and the whole stretch is
    // refused as an under-determined mutating argument.
    const traces: StretchTrace[] = [];
    for (let i = 0; i < 6; i++) {
      const opts = { mode: "fast", retries: 2 };
      const shared = i % 2 === 0;
      traces.push({
        id: `g${i}`,
        llmCalls: 3,
        duration_ms: 30,
        cost_cents: 3,
        input: { id: `G-${i}` },
        events: [
          { name: "fetchRecord", args: { id: `G-${i}` }, result: { id: `G-${i}` }, ok: true },
          {
            name: "postUpdate",
            args: shared
              ? { id: `G-${i}`, opts, echo: opts }
              : { id: `G-${i}`, opts: { mode: "fast", retries: 2 }, echo: { mode: "fast", retries: 2 } },
            result: { ok: true },
            ok: true,
          },
          { name: "notify", args: { id: `G-${i}` }, result: { ok: true }, ok: true },
        ],
      });
    }
    const { programs, refusals } = compileTraces(traces);
    expect(refusals.map((r) => r.reason)).not.toContain("postUpdate arguments are under-determined");
    expect(programs.length).toBe(1);
    const post = programs[0]!.steps.find((s) => s.kind === "tool" && s.tool === "postUpdate");
    expect(post).toBeDefined();
    const opts = (post as { args: Record<string, { kind: string; value?: unknown }> }).args.opts;
    expect(opts).toBeDefined();
    expect(opts!.kind).toBe("literal");
    expect(opts!.value).toEqual({ mode: "fast", retries: 2 });
  });

  test("oneInsert does not merge away a check tool", () => {
    expect(oneInsert(["lookup", "write", "verifyWrite", "notify"], ["lookup", "write", "notify"])).toBe(false);
    expect(oneInsert(["lookup", "write", "notify"], ["lookup", "tagItem", "write", "notify"])).toBe(true);
    expect(oneSubstitute(["lookup", "verifyWrite", "notify"], ["lookup", "draftReply", "notify"])).toBe(false);
  });
});
