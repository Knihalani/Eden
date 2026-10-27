import { describe, expect, test } from "bun:test";
import type { StretchProgram } from "@eden/ir";
import type { ToolRegistry } from "@eden/ir";
import { runProgram } from "./execute";
import { composedRegistry } from "./compose";

/**
 * Tool composition (G6): a compiled tool becomes callable AS a tool by
 * other programs — Voyager's skill layering, but with admission gates.
 * The composed registry resolves sub-program names so a parent program's
 * steps can target them transparently.
 */
describe("composed registries", () => {
  const detailProgram: StretchProgram = {
    id: "sub_detail",
    version: "1",
    name: "fetch_detail",
    description: "Fetch ticket detail.",
    inputSchema: { type: "object", properties: { ticket_id: { type: "string" } }, required: ["ticket_id"] },
    sequence: ["fetchDetail"],
    steps: [{ id: "fd", kind: "tool", tool: "fetchDetail", args: { ticket_id: { kind: "input", path: "ticket_id" } } }],
    returns: { kind: "from", step: "fd", path: "" },
    contract: { witnesses: 2, minLlmReduction: 2, allowExact: false },
    manifest: null,
  } as unknown as StretchProgram;

  function makeBase(): { reg: ToolRegistry; calls: Array<{ tool: string; args: Record<string, unknown> }> } {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const base = {
      fetchDetail: async (args: Record<string, unknown>) => {
        calls.push({ tool: "fetchDetail", args });
        return { id: args.ticket_id, priority: "high" };
      },
      notify: async () => ({ notified: true }),
    };
    const reg = composedRegistry(base, {
      fetch_detail: { program: detailProgram },
    });
    return { reg, calls };
  }

  test("sub-program is addressable through the composed registry", async () => {
    const { reg, calls } = makeBase();
    expect(reg.has?.("fetch_detail")).toBe(true);
    expect(reg.has?.("fetchDetail")).toBe(true);
    const result = await reg.execute!("fetch_detail", { ticket_id: "T-1" });
    expect(result).toEqual({ id: "T-1", priority: "high" });
    expect(calls.some((c) => c.tool === "fetchDetail" && c.args.ticket_id === "T-1")).toBe(true);
  });

  test("a parent program calls the sub-program by name in a loop", async () => {
    const parent: StretchProgram = {
      id: "p_batch",
      version: "1",
      name: "batch_lookup",
      description: "Fetch ticket detail.",
      inputSchema: {
        type: "object",
        properties: { ids: { type: "array", items: { type: "string" } } },
        required: ["ids"],
      },
      sequence: ["loop_ids"],
      steps: [
        {
          id: "loop_ids",
          kind: "loop",
          over: { kind: "input", path: "ids" },
          item: "id",
          body: ["call_detail"],
          parallel: true,
        },
        {
          id: "call_detail",
          kind: "tool",
          tool: "fetch_detail",
          args: { ticket_id: { kind: "from", step: "id", path: "" } },
        },
      ],
      returns: { kind: "from", step: "loop_ids", path: "" },
      contract: { witnesses: 2, minLlmReduction: 2, allowExact: false },
      manifest: null,
    } as unknown as StretchProgram;

    const { reg, calls } = makeBase();
    const out = await runProgram(
      parent,
      { ids: ["A", "B", "C"] },
      {
        registry: reg,
        checkEnvelope: false,
      },
    );
    expect(calls.filter((c) => c.tool === "fetchDetail").length).toBe(3);
    const results = out.value as Array<{ id: string; priority: string }>;
    expect(results.map((r) => r.id)).toEqual(["A", "B", "C"]);
  });

  test("base tools remain accessible alongside sub-programs", async () => {
    const { reg } = makeBase();
    expect(reg.has?.("fetchDetail")).toBe(true);
    expect(reg.has?.("notify")).toBe(true);
    expect(reg.has?.("fetch_detail")).toBe(true);
    const result = await reg.execute!("notify", {});
    expect(result).toEqual({ notified: true });
  });

  test("a handoff-shaped parent runs two child programs through composedRegistry", async () => {
    const intake: StretchProgram = {
      id: "p_intake",
      version: "1",
      name: "lookupTicket_to_classifyIssue",
      description: "Intake.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      sequence: ["lookupTicket", "classifyIssue"],
      steps: [
        { id: "lt", kind: "tool", tool: "lookupTicket", args: { id: { kind: "input", path: "id" } } },
        { id: "cl", kind: "tool", tool: "classifyIssue", args: { id: { kind: "input", path: "id" } } },
      ],
      returns: { kind: "from", step: "cl", path: "" },
      contract: { witnesses: 3, minLlmReduction: 2, allowExact: false },
      manifest: null,
    };
    const billing: StretchProgram = {
      id: "p_billing",
      version: "1",
      name: "fetchInvoice_to_applyCredit",
      description: "Billing.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      sequence: ["fetchInvoice", "applyCredit"],
      steps: [
        { id: "fi", kind: "tool", tool: "fetchInvoice", args: { id: { kind: "input", path: "id" } } },
        { id: "ac", kind: "tool", tool: "applyCredit", args: { id: { kind: "input", path: "id" } } },
      ],
      returns: { kind: "from", step: "ac", path: "" },
      contract: { witnesses: 3, minLlmReduction: 2, allowExact: false },
      manifest: null,
    };
    const parent: StretchProgram = {
      id: "p_handoff",
      version: "1",
      name: "intake_to_billing",
      description: "Composed handoff: lookupTicket_to_classifyIssue → fetchInvoice_to_applyCredit.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      sequence: [intake.name, billing.name],
      steps: [
        { id: "intake", kind: "tool", tool: intake.name, args: { id: { kind: "input", path: "id" } } },
        { id: "billing", kind: "tool", tool: billing.name, args: { id: { kind: "from", step: "intake", path: "id" } } },
      ],
      returns: { kind: "from", step: "billing", path: "" },
      contract: { witnesses: 3, minLlmReduction: 2, allowExact: false },
      manifest: null,
      origin: { mode: "handoff" },
      composedOf: [intake.id, billing.id],
    };
    const calls: string[] = [];
    const reg = composedRegistry(
      {
        lookupTicket: async (args: Record<string, unknown>) => {
          calls.push("lookupTicket");
          return { ok: true, id: args.id };
        },
        classifyIssue: async (args: Record<string, unknown>) => {
          calls.push("classifyIssue");
          return { class: "billing", id: args.id };
        },
        fetchInvoice: async (args: Record<string, unknown>) => {
          calls.push("fetchInvoice");
          return { id: args.id, total: 40 };
        },
        applyCredit: async (args: Record<string, unknown>) => {
          calls.push("applyCredit");
          return { applied: true, id: args.id };
        },
      },
      {
        [intake.name]: { program: intake },
        [billing.name]: { program: billing },
      },
    );
    const out = await runProgram(parent, { id: "T-0" }, { registry: reg, checkEnvelope: false });
    expect(calls).toEqual(["lookupTicket", "classifyIssue", "fetchInvoice", "applyCredit"]);
    expect(out.value).toEqual({ applied: true, id: "T-0" });
    expect(parent.manifest).toBeNull();
  });
});
