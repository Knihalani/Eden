/**
 * After a clean live run, absorb sibling-width ids into the envelope (K=3)
 * and refresh the envelope from in-distribution receipts (existing keys only).
 * Fail-open: parse/inherit throws leave the live tool untouched.
 */
import { inheritWidth, type WidthInheritReceipt } from "@eden/compile";
import { rollEnvelope } from "@eden/shadow";
import type { Store } from "./store";

function receiptOf(payload: string | null | undefined, ok: number): WidthInheritReceipt {
  let input: Record<string, unknown> | undefined;
  let events: WidthInheritReceipt["events"];
  if (payload) {
    try {
      const extra = JSON.parse(payload) as { input?: unknown; events?: unknown };
      if (extra.input && typeof extra.input === "object" && !Array.isArray(extra.input)) {
        input = extra.input as Record<string, unknown>;
      }
      if (Array.isArray(extra.events)) events = extra.events as WidthInheritReceipt["events"];
    } catch {
      /* ignore corrupt payload */
    }
  }
  return { ok: ok === 1, input, events };
}

export function inheritLiveTool(store: Store, toolId: string): void {
  try {
    const t = store.tool(toolId);
    if (!t) return;
    const recs = store.receiptsFor(toolId).map((r) => receiptOf(r.payload, r.ok));
    let next = inheritWidth(t.program, recs);
    for (const r of recs) next = rollEnvelope(next, r);
    if (next.version === t.program.version) return;
    t.program = next;
    t.version = next.version;
    t.updated_at = Date.now();
    store.putTool(t);
  } catch {
    /* fail-open */
  }
}
