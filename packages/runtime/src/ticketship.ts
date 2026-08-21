import type { IslandCaller, StretchProgram, StretchTrace, ToolExecute } from "@eden/ir";
import { withVersion } from "@eden/ir";

export const WITNESS_IDS = ["T-100", "T-101", "T-102"] as const;
export const OOD_ID = "T-999";
export const LLM_MS = 200;
export const LLM_CENTS = 1;
export const SKIP_VERIFY_P = 0.2;

export const TICKETS: Record<string, { customer: string; status: string; priority: string; body: string }> = {
  "T-100": { customer: "Acme", status: "open", priority: "high", body: "Cannot login after the SSO cutover." },
  "T-101": { customer: "Beta", status: "open", priority: "med", body: "Dashboard widgets stall on Friday reports." },
  "T-102": { customer: "Gamma", status: "open", priority: "low", body: "Typo in the billing email footer." },
  "T-999": { customer: "Novel", status: "open", priority: "high", body: "A ticket id never seen in witnesses." },
};

export type TicketShipStats = {
  llmCalls: number;
  duration_ms: number;
  cost_cents: number;
  skipped: string[];
  tools: string[];
  wrote: boolean;
  verified: boolean;
  notified: boolean;
  complete: boolean;
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The fixture's tool surface, named so callers keep the keys through wrapTools(). */
export type TicketToolName =
  | "lookupTicket"
  | "fetchDetails"
  | "parseFields"
  | "validate"
  | "draftReply"
  | "writeRecord"
  | "verifyWrite"
  | "notify";

export function createTicketShip(opts: { llmMs?: number; llmCents?: number } = {}) {
  const llmMs = opts.llmMs ?? LLM_MS;
  const llmCents = opts.llmCents ?? LLM_CENTS;
  const writes = new Map<string, Record<string, unknown>>();
  const verified = new Set<string>();
  const notified = new Set<string>();
  let islandDrafts = 0;

  // Keyed by the named union rather than `string`: the value type stays uniform
  // (so the map is still assignable to ToolsIn) while the key names survive, and
  // callers of wrapTools() get `tools.lookupTicket` typed as present instead of
  // `… | undefined` falling out of an index signature.
  const tools: Record<TicketToolName, { description: string; execute: ToolExecute }> = {
    lookupTicket: {
      description: "Look up a support ticket by id.",
      execute: ({ id }) => {
        const t = TICKETS[String(id)];
        if (!t) return { ok: false, id };
        return { ok: true, id, customer: t.customer, status: t.status };
      },
    },
    fetchDetails: {
      description: "Fetch full ticket details.",
      execute: ({ id }) => {
        const t = TICKETS[String(id)];
        if (!t) return { ok: false, id };
        return { id, ...t };
      },
    },
    parseFields: {
      description: "Parse structured fields from ticket details.",
      execute: ({ details }) => {
        const d = (details ?? {}) as Record<string, unknown>;
        const body = String(d.body ?? "");
        return {
          customer: d.customer,
          priority: d.priority,
          issue: body.slice(0, 80),
          category: body.toLowerCase().includes("login") ? "auth" : "general",
        };
      },
    },
    validate: {
      description: "Validate parsed ticket fields.",
      execute: ({ fields }) => {
        const f = (fields ?? {}) as Record<string, unknown>;
        return { ok: Boolean(f.customer && f.issue), fields: f };
      },
    },
    draftReply: {
      description: "Draft a free-text support reply. Judgment; not compilable as a tool.",
      execute: ({ fields }) => {
        const f = (fields ?? {}) as Record<string, unknown>;
        return { text: `Hi ${f.customer}, we received: ${f.issue}` };
      },
    },
    writeRecord: {
      description: "Persist the resolution record. Mutating.",
      execute: ({ id, customer, issue, reply }, ctx) => {
        if (ctx?.signal?.aborted) throw new Error("aborted");
        const record = { customer, issue, reply };
        writes.set(String(id), record);
        return { written: true, id, record };
      },
    },
    verifyWrite: {
      description: "Verify the record was written. Required; naive agents skip this.",
      execute: ({ id }, ctx) => {
        if (ctx?.signal?.aborted) throw new Error("aborted");
        const ok = writes.has(String(id));
        if (ok) verified.add(String(id));
        return { verified: ok, id };
      },
    },
    notify: {
      description: "Notify the customer. Mutating.",
      execute: ({ id }, ctx) => {
        if (ctx?.signal?.aborted) throw new Error("aborted");
        notified.add(String(id));
        return { notified: true, id };
      },
    },
  };

  const island: IslandCaller = async ({ input, signal }) => {
    islandDrafts++;
    if (signal?.aborted) throw new Error("aborted");
    if (llmMs > 0) await Bun.sleep(llmMs);
    if (signal?.aborted) throw new Error("aborted");
    const f = (input ?? {}) as Record<string, unknown>;
    return { text: `Hi ${f.customer}, thanks for reporting this. We are on it: ${f.issue}` };
  };

  const mockLlm = async () => {
    if (llmMs > 0) await Bun.sleep(llmMs);
  };

  return {
    tools,
    writes,
    verified,
    notified,
    island,
    mockLlm,
    llmCents,
    llmMs,
    islandDrafts: () => islandDrafts,
    mutationsFor(id: string) {
      return { wrote: writes.has(id), verified: verified.has(id), notified: notified.has(id) };
    },
  };
}

export type TicketShipWorld = ReturnType<typeof createTicketShip>;

export async function runNaive(
  world: TicketShipWorld,
  id: string,
  opts: { skipVerifyP?: number; seed?: number } = {},
): Promise<{ output: unknown; stats: TicketShipStats; events: Array<{ name: string; args: Record<string, unknown>; result: unknown; ok: boolean }> }> {
  const skipP = opts.skipVerifyP ?? SKIP_VERIFY_P;
  const rng = mulberry32(opts.seed ?? 1);
  const t0 = performance.now();
  const tools: string[] = [];
  const skipped: string[] = [];
  const events: Array<{ name: string; args: Record<string, unknown>; result: unknown; ok: boolean }> = [];
  let llmCalls = 0;

  const call = async (name: TicketToolName, args: Record<string, unknown>) => {
    await world.mockLlm();
    llmCalls++;
    const result = await world.tools[name].execute(args);
    tools.push(name);
    events.push({ name, args, result, ok: true });
    return result as Record<string, unknown>;
  };

  await call("lookupTicket", { id });
  const details = await call("fetchDetails", { id });
  const fields = await call("parseFields", { details });
  const valid = await call("validate", { fields });
  if (!valid.ok) {
    return {
      output: valid,
      events,
      stats: {
        llmCalls,
        duration_ms: performance.now() - t0,
        cost_cents: llmCalls * world.llmCents,
        skipped,
        tools,
        wrote: false,
        verified: false,
        notified: false,
        complete: false,
      },
    };
  }
  const draft = await call("draftReply", { fields });
  await call("writeRecord", { id, customer: fields.customer, issue: fields.issue, reply: (draft as { text: string }).text });
  if (rng() < skipP) skipped.push("verifyWrite");
  else await call("verifyWrite", { id });
  const output = await call("notify", { id });
  const mut = world.mutationsFor(id);
  return {
    output,
    events,
    stats: {
      llmCalls,
      duration_ms: performance.now() - t0,
      cost_cents: llmCalls * world.llmCents,
      skipped,
      tools,
      wrote: mut.wrote,
      verified: mut.verified,
      notified: mut.notified,
      complete: mut.wrote && mut.notified,
    },
  };
}

/** StretchTrace from a naive TicketShip run. Tokens are measured; wall clock is the synthetic fixture. */
export function toNaiveTrace(
  id: string,
  ticketId: string,
  run: Awaited<ReturnType<typeof runNaive>>,
): StretchTrace {
  const llm = run.stats.llmCalls;
  return {
    id,
    events: run.events,
    input: { id: ticketId },
    output: run.output,
    llmCalls: llm,
    duration_ms: LLM_MS * llm,
    cost_cents: run.stats.cost_cents,
    skipped: run.stats.skipped,
    complete: run.stats.complete,
    prompt_tokens: 40 * llm,
    completion_tokens: 10 * llm,
  };
}

export function ticketShipProgram(): StretchProgram {
  return withVersion({
    id: "ticketship",
    name: "resolve_ticket",
    description:
      "Resolve a support ticket: look up, fetch details, parse and validate fields, draft a reply, write the record, verify the write, and notify. Use this instead of calling lookupTicket, fetchDetails, parseFields, validate, draftReply, writeRecord, verifyWrite, and notify in sequence.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Ticket id" } },
      required: ["id"],
    },
    sequence: [
      "lookupTicket",
      "fetchDetails",
      "parseFields",
      "validate",
      "draftReply",
      "writeRecord",
      "verifyWrite",
      "notify",
    ],
    steps: [
      { id: "lookup", kind: "tool", tool: "lookupTicket", args: { id: { kind: "input", path: "id" } } },
      { id: "details", kind: "tool", tool: "fetchDetails", args: { id: { kind: "input", path: "id" } } },
      {
        id: "parsed",
        kind: "tool",
        tool: "parseFields",
        args: { details: { kind: "from", step: "details", path: "" } },
      },
      {
        id: "valid",
        kind: "tool",
        tool: "validate",
        args: { fields: { kind: "from", step: "parsed", path: "" } },
      },
      { id: "validOk", kind: "assert", expr: "ok == true", onFail: "deopt" },
      {
        id: "draft",
        kind: "island",
        input: { kind: "from", step: "parsed", path: "" },
        system: "Draft a short, specific support reply. Return JSON {text}.",
        outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
      {
        id: "write",
        kind: "tool",
        tool: "writeRecord",
        args: {
          id: { kind: "input", path: "id" },
          customer: { kind: "from", step: "parsed", path: "customer" },
          issue: { kind: "from", step: "parsed", path: "issue" },
          reply: { kind: "from", step: "draft", path: "text" },
        },
      },
      { id: "verify", kind: "tool", tool: "verifyWrite", args: { id: { kind: "input", path: "id" } } },
      { id: "verified", kind: "assert", expr: "verified == true", onFail: "error" },
      { id: "notify", kind: "tool", tool: "notify", args: { id: { kind: "input", path: "id" } } },
    ],
    returns: { kind: "from", step: "notify", path: "" },
    contract: {
      witnesses: 3,
      minLlmReduction: 2,
      allowExact: false,
      envelope: { inputs: { id: [...WITNESS_IDS] } },
    },
    manifest: null,
  });
}

export function underdeterminedSiblingTraces(n = 3) {
  return Array.from({ length: n }, (_, i) => {
    const id = WITNESS_IDS[i % WITNESS_IDS.length]!;
    const details = { id, ...TICKETS[id]! };
    const fields = {
      customer: details.customer,
      priority: details.priority,
      issue: details.body.slice(0, 80),
      category: "general",
    };
    return {
      id: `sib-${i}`,
      llmCalls: 8,
      duration_ms: 1600,
      cost_cents: 8,
      input: { id },
      complete: true,
      events: [
        { name: "lookupTicket", args: { id }, result: { ok: true, id }, ok: true },
        { name: "fetchDetails", args: { id }, result: details, ok: true },
        { name: "parseFields", args: { details }, result: fields, ok: true },
        { name: "validate", args: { fields }, result: { ok: true, fields }, ok: true },
        { name: "draftReply", args: { fields }, result: { text: "hello" }, ok: true },
        {
          name: "writeRecord",
          args: i === 0 ? { email: details.customer, issue: fields.issue } : { id, customer: details.customer, issue: fields.issue, reply: "hello" },
          result: { written: true },
          ok: true,
        },
        { name: "verifyWrite", args: { id }, result: { verified: true, id }, ok: true },
        { name: "notify", args: { id }, result: { notified: true, id }, ok: true },
      ],
    };
  });
}
