import type { StretchTrace, TraceEvent } from "@eden/ir";
import { canonicalize, cloneJson, isReadName, redact } from "@eden/ir";
import { stripNegativeSpace } from "./negative";

/** Normalized traces that dropped an `ok: false` attempt — shape vote, not envelope. */
const retriedWitnesses = new WeakSet<StretchTrace>();

export function witnessHadFailedAttempt(t: StretchTrace): boolean {
  if (retriedWitnesses.has(t)) return true;
  return t.events.some((e) => e.ok === false);
}

/** Identical leftover reads after poll-strip. Keep-first is safe: waits already resolved. */
function collapseConsecutiveReads(events: TraceEvent[]): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const ev of events) {
    const prev = out.at(-1);
    if (
      prev &&
      isReadName(ev.name) &&
      prev.name === ev.name &&
      canonicalize(prev.args) === canonicalize(ev.args)
    ) {
      continue;
    }
    out.push(ev);
  }
  return out;
}

export function normalizeTrace(trace: StretchTrace): StretchTrace {
  const raw: TraceEvent[] = [];
  let droppedFail = false;
  for (const ev of trace.events) {
    if (!ev.ok) {
      droppedFail = true;
      continue;
    }
    const args = redact(ev.args) as Record<string, unknown>;
    const result = redact(ev.result);
    raw.push({ ...ev, args, result });
  }
  const redactedInput = redact(trace.input) as Record<string, unknown> | undefined;
  const inputForStrip = redactedInput && Object.keys(redactedInput).length ? redactedInput : inferInput(raw);
  // Strip waits on the full run (pending→done) before keep-first collapse,
  // or a poll compile would bake the first stale `pending`.
  const events = collapseConsecutiveReads(stripNegativeSpace(raw, inputForStrip));
  const out: StretchTrace = {
    ...trace,
    events,
    input: redactedInput ?? inferInput(events),
  };
  if (droppedFail) retriedWitnesses.add(out);
  return out;
}

export function inferInput(events: TraceEvent[]): Record<string, unknown> {
  const first = events.find((e) => e.ok);
  return cloneJson(first?.args ?? {});
}

export function normalizeTraces(traces: StretchTrace[]): StretchTrace[] {
  return traces.map(normalizeTrace).filter((t) => t.events.length >= 2);
}
