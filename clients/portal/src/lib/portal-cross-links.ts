/**
 * U19 cross-link matrix — deep-link builders for core portal journeys.
 * Trace ↔ Issue ↔ Artifact ↔ Experiment ↔ Dataset ↔ Ledger
 */

export type CrossLinkKind =
  | "trace"
  | "issue"
  | "artifact"
  | "playground"
  | "dataset"
  | "experiment"
  | "ledger"
  | "drift"
  | "labeling"
  | "incident"
  | "promotions";

export interface CrossLinkDef {
  from: string;
  to: CrossLinkKind;
  label: string;
  href: (params: Record<string, string | undefined>) => string;
}

export function traceHref(traceId: string): string {
  return `/traces?traceId=${encodeURIComponent(traceId)}`;
}

export function issueHref(issueId: string): string {
  return `/issues?issueId=${encodeURIComponent(issueId)}`;
}

export function issueFullHref(issueId: string): string {
  return `/issues/${encodeURIComponent(issueId)}`;
}

export function artifactHref(artifactId?: string): string {
  if (artifactId) return `/artifacts?artifactId=${encodeURIComponent(artifactId)}`;
  return "/artifacts";
}

export function playgroundHref(traceId?: string, spanId?: string): string {
  const q = new URLSearchParams({ tab: "playgrounds" });
  if (traceId) q.set("trace_id", traceId);
  if (spanId) q.set("span_id", spanId);
  return `/evals?${q.toString()}`;
}

export function datasetHref(datasetId?: string): string {
  if (datasetId) return `/datasets/${encodeURIComponent(datasetId)}`;
  return "/evals?tab=datasets";
}

export function experimentHref(experimentId?: string, issueId?: string): string {
  const q = new URLSearchParams({ tab: "experiments" });
  if (experimentId) q.set("experimentId", experimentId);
  if (issueId) q.set("issueId", issueId);
  return `/evals?${q.toString()}`;
}

export function ledgerHref(agentId?: string): string {
  if (agentId) return `/agents/${encodeURIComponent(agentId)}/ledger`;
  return "/ledger";
}

export function driftHref(agentId: string, dimension?: string): string {
  const q = dimension ? `?dimension=${encodeURIComponent(dimension)}` : "";
  return `/agents/${encodeURIComponent(agentId)}/drift${q}`;
}

export function tracesFilteredHref(filters: {
  agent_id?: string;
  outcome?: string;
  dimension?: string;
}): string {
  const q = new URLSearchParams();
  if (filters.agent_id) q.set("agent_id", filters.agent_id);
  if (filters.outcome) q.set("outcome", filters.outcome);
  if (filters.dimension) q.set("q", `dimension:${filters.dimension}`);
  const qs = q.toString();
  return qs ? `/traces?${qs}` : "/traces";
}

export function labelingQueueHref(queueId?: string): string {
  if (queueId) return `/labeling/queues/${encodeURIComponent(queueId)}`;
  return "/evals?tab=labeling";
}

export function incidentHref(clusterId?: string): string {
  if (clusterId) return `/incidents/${encodeURIComponent(clusterId)}`;
  return "/issues?tab=incidents";
}

export function promotionsHref(): string {
  return "/promotions";
}

/** Required cross-link matrix entries (U19 §3) — used by CI tests. */
export const CROSS_LINK_MATRIX: CrossLinkDef[] = [
  { from: "trace", to: "issue", label: "View issue", href: (p) => issueHref(p.id!) },
  { from: "trace", to: "artifact", label: "Create artifact", href: () => artifactHref() },
  { from: "trace", to: "playground", label: "Open span", href: (p) => playgroundHref(p.traceId, p.spanId) },
  { from: "trace", to: "dataset", label: "Add to dataset", href: () => datasetHref() },
  { from: "trace", to: "labeling", label: "Seed queue", href: () => labelingQueueHref() },
  { from: "issue", to: "experiment", label: "Run experiment", href: (p) => experimentHref(undefined, p.id) },
  { from: "issue", to: "artifact", label: "Create artifact", href: () => artifactHref() },
  { from: "alert", to: "incident", label: "View incident", href: () => incidentHref() },
  { from: "alert", to: "trace", label: "Example traces", href: () => "/traces" },
  { from: "artifact", to: "trace", label: "Outcomes", href: (p) => tracesFilteredHref({ agent_id: p.agentId }) },
  { from: "drift", to: "trace", label: "Show traces", href: (p) => tracesFilteredHref({ agent_id: p.agentId, dimension: p.dimension }) },
  { from: "dataset", to: "playground", label: "Run playground", href: () => playgroundHref() },
  { from: "dataset", to: "experiment", label: "Run experiment", href: () => experimentHref() },
  { from: "experiment", to: "trace", label: "Datapoint traces", href: (p) => traceHref(p.traceId ?? "") },
];
