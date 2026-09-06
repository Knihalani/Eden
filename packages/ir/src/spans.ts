/**
 * Parent/child attribution: live wrap traces vs an orchestrator span list.
 *
 * OpenTelemetry GenAI: `invoke_workflow` parents `invoke_agent`. We match on
 * spanId / parentRunId / agentId — not a flat event dump.
 */
import type { StretchTrace } from "./types";

export type OrchestratorSpan = {
  spanId: string;
  parentSpanId?: string;
  agentId: string;
  name: string;
};

export type SpanTrace = Pick<StretchTrace, "id" | "spanId" | "spanName" | "parentRunId" | "agentId">;

/**
 * True when every orchestrator span has a trace with the same spanId, the
 * same agentId, the same span name (`invoke_workflow` / `invoke_agent`), and
 * (for children) parentRunId equal to the parent trace's id.
 */
export function tracesMatchSpans(traces: SpanTrace[], orchestratorSpans: OrchestratorSpan[]): boolean {
  if (!orchestratorSpans.length) return traces.length === 0;
  const bySpan = new Map<string, SpanTrace>();
  for (const t of traces) {
    if (typeof t.spanId === "string" && t.spanId) bySpan.set(t.spanId, t);
  }
  for (const span of orchestratorSpans) {
    const hit = bySpan.get(span.spanId);
    if (!hit) return false;
    if (span.agentId && hit.agentId !== span.agentId) return false;
    if (span.name && hit.spanName !== span.name) return false;
    if (span.parentSpanId) {
      const parent = bySpan.get(span.parentSpanId);
      if (!parent) return false;
      if (hit.parentRunId !== parent.id) return false;
      if (span.name === "invoke_agent" && hit.spanName !== "invoke_agent") return false;
    } else if (span.name === "invoke_workflow" && hit.spanName !== "invoke_workflow") {
      return false;
    }
  }
  return true;
}
