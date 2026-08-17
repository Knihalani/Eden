import type { StretchTrace, TraceEvent } from "@eden/ir";
import { canonicalize, cloneJson, isReadName, redact } from "@eden/ir";

export function normalizeTrace(trace: StretchTrace): StretchTrace {
  const events: TraceEvent[] = [];
  for (const ev of trace.events) {
    if (!ev.ok) continue;
    const args = redact(ev.args) as Record<string, unknown>;
    const result = redact(ev.result);
    const prev = events.at(-1);
    if (
      prev &&
      isReadName(ev.name) &&
      prev.name === ev.name &&
      canonicalize(prev.args) === canonicalize(args)
    ) {
      continue;
    }
    events.push({ ...ev, args, result });
  }
  return {
    ...trace,
    events,
    input: (redact(trace.input) as Record<string, unknown> | undefined) ?? inferInput(events),
  };
}

export function inferInput(events: TraceEvent[]): Record<string, unknown> {
  const first = events.find((e) => e.ok);
  return cloneJson(first?.args ?? {});
}

export function normalizeTraces(traces: StretchTrace[]): StretchTrace[] {
  return traces.map(normalizeTrace).filter((t) => t.events.length >= 2);
}
