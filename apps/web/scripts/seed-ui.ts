import { homedir } from "node:os";
import { join } from "node:path";
import { Store } from "@eden/control";
import { ticketShipProgram } from "../../../packages/runtime/src/ticketship";

const db = process.env.EDEN_DB || join(process.env.EDEN_HOME || join(homedir(), ".eden"), "control.sqlite");
const store = new Store(db);
const now = Date.now();
const program = ticketShipProgram();
const manifest = {
  llmReduction: 2.4,
  latencyReduction: 1.8,
  costReduction: 2.1,
  skipRateBefore: 0.12,
  skipRateAfter: 0,
  nShadow: 6,
};
program.manifest = manifest;

store.putCandidate({
  id: "cand_resolve",
  sequence: program.sequence ?? [],
  program: { ...program, name: "resolve_ticket" },
  refusal: null,
  verdict: "PASS",
  manifest,
  created_at: now,
});

store.putCandidate({
  id: "cand_pending",
  sequence: ["searchDocs", "summarize", "postSlack"],
  program: {
    ...program,
    id: "pending_docs",
    name: "brief_from_docs",
    sequence: ["searchDocs", "summarize", "postSlack"],
    steps: [
      { id: "search", kind: "tool", tool: "searchDocs", args: { q: { kind: "input", path: "q" } } },
      {
        id: "sum",
        kind: "island",
        input: { kind: "from", step: "search", path: "" },
        system: "Summarize the hits.",
        outputSchema: { type: "object" },
      },
      { id: "post", kind: "tool", tool: "postSlack", args: { text: { kind: "from", step: "sum", path: "text" } } },
    ],
    manifest: null,
  },
  refusal: null,
  verdict: "pending",
  manifest: null,
  created_at: now - 60_000,
});

store.putCandidate({
  id: "cand_refused",
  sequence: ["lookupTicket", "writeRecord"],
  program: null,
  refusal: {
    sequence: ["lookupTicket", "writeRecord"],
    reason: "writeRecord.id is under-determined",
    slot: "writeRecord.id",
  },
  verdict: "FAIL",
  manifest: null,
  created_at: now - 120_000,
});

store.putTool({
  id: "live_notify",
  name: "notify_oncall",
  version: "1",
  program: {
    ...program,
    id: "notify_oncall",
    name: "notify_oncall",
    sequence: ["lookupTicket", "notify"],
    steps: program.steps.filter((s) => s.kind === "tool" && (s.tool === "lookupTicket" || s.tool === "notify")),
  },
  state: "live",
  created_at: now - 86400000,
  updated_at: now - 3600000,
});

store.putReceipt({ tool_id: "live_notify", version: "1", ms: 42, llm_calls: 0, cents: 0.2, ok: 1 });
store.putReceipt({ tool_id: "live_notify", version: "1", ms: 38, llm_calls: 0, cents: 0.2, ok: 1 });
store.putReceipt({ tool_id: "live_notify", version: "1", ms: 51, llm_calls: 0, cents: 0.2, ok: 1 });
store.putReceipt({ tool_id: "live_notify", version: "1", ms: 0, llm_calls: 0, cents: 0, ok: 0 });
store.putReceipt({ tool_id: "live_notify", version: "1", ms: 44, llm_calls: 0, cents: 0.2, ok: 1 });

store.putTool({
  id: "live_paused",
  name: "sync_accounts",
  version: "1",
  program: {
    ...program,
    id: "sync_accounts",
    name: "sync_accounts",
    sequence: ["lookupTicket", "fetchDetails", "notify"],
    steps: program.steps.filter(
      (s) => s.kind === "tool" && (s.tool === "lookupTicket" || s.tool === "fetchDetails" || s.tool === "notify"),
    ),
  },
  state: "paused",
  created_at: now - 172800000,
  updated_at: now - 7200000,
});
store.putReceipt({ tool_id: "live_paused", version: "1", ms: 120, llm_calls: 0, cents: 0.4, ok: 1 });
store.heartbeat();

console.log("seeded", db, {
  candidates: store.candidates().map((c) => c.id),
  live: store.tools().map((t) => t.name),
  savings: store.savings(),
});
