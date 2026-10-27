import type { StretchTrace, TraceEvent } from "@eden/ir";
import { canonicalize, cloneJson, containsSecret, isReadName, redact } from "@eden/ir";
import { stripNegativeSpace } from "./negative";

/** Normalized traces that dropped an `ok: false` attempt — shape vote, not envelope. */
const retriedWitnesses = new WeakSet<StretchTrace>();

export function witnessHadFailedAttempt(t: StretchTrace): boolean {
  if (retriedWitnesses.has(t)) return true;
  return t.events.some((e) => e.ok === false);
}

/** Identical leftover reads after poll-strip. Keep-first is safe: waits already resolved.
 *  Same-args reads whose result carries a poll flag (ready/done/…) are left
 *  intact so compile can mine `until` or refuse a never-ready wait. */
function collapseConsecutiveReads(events: TraceEvent[]): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const ev of events) {
    const prev = out.at(-1);
    if (
      prev &&
      isReadName(ev.name) &&
      prev.name === ev.name &&
      canonicalize(prev.args) === canonicalize(ev.args) &&
      canonicalize(prev.result) === canonicalize(ev.result) &&
      !looksLikePollResult(ev.result)
    ) {
      continue;
    }
    out.push(ev);
  }
  return out;
}

function looksLikePollResult(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const rec = result as Record<string, unknown>;
  for (const k of ["ready", "done", "complete", "available", "succeeded"]) {
    const v = rec[k];
    if (typeof v === "boolean" || typeof v === "string") return true;
  }
  return false;
}

function consecutiveSameName(events: TraceEvent[]): boolean {
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.name === events[i - 1]!.name) return true;
  }
  return false;
}

function traceHasSecret(trace: StretchTrace, events: TraceEvent[]): boolean {
  // Scan the live objects — do not wrap every event in a fresh {args,result}
  // just to walk it (that allocated 2k × 12 objects on synth2000).
  if (containsSecret(trace.input)) return true;
  for (const e of events) {
    if (containsSecret(e.args) || containsSecret(e.result)) return true;
  }
  return false;
}

export function normalizeTrace(trace: StretchTrace): StretchTrace {
  let droppedFail = false;
  let raw: TraceEvent[] = trace.events;
  const hasFail = trace.events.some((e) => !e.ok);
  if (hasFail) {
    const laterOk = new Set<string>();
    const keep: TraceEvent[] = [];
    for (let i = trace.events.length - 1; i >= 0; i--) {
      const e = trace.events[i]!;
      const k = `${e.name}\0${canonicalize(e.args)}`;
      if (e.ok) {
        laterOk.add(k);
        keep.push(e);
      } else if (laterOk.has(k)) {
        keep.push(e);
      } else {
        droppedFail = true;
      }
    }
    keep.reverse();
    raw = keep;
  }

  const secret = traceHasSecret(trace, raw);
  if (secret) {
    raw = raw.map((ev) => ({
      ...ev,
      args: redact(ev.args) as Record<string, unknown>,
      result: redact(ev.result),
    }));
  }
  const redactedInput = secret
    ? (redact(trace.input) as Record<string, unknown> | undefined)
    : (trace.input as Record<string, unknown> | undefined);
  const inputForStrip = redactedInput && Object.keys(redactedInput).length ? redactedInput : inferInput(raw);

  let events = raw;
  // Poll-strip and keep-first collapse only fire on consecutive same-name
  // runs. Homogeneous stretches (synth500, ETL) never have those, so skip
  // the canonicalize/flatten walks entirely.
  if (raw.length >= 2 && consecutiveSameName(raw)) {
    events = collapseConsecutiveReads(stripNegativeSpace(raw, inputForStrip));
  }

  if (!droppedFail && events === trace.events && redactedInput === trace.input) return trace;

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
