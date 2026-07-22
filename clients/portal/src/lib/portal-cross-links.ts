/**
 * U19 cross-link matrix — deep-link builders for core portal journeys.
 * Trace ↔ Issue ↔ Artifact ↔ Experiment ↔ Dataset ↔ Ledger
 *
 * Wave 7: Eval ↔ Trace links preserve Observe filters / time window when provided.
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
  | "promotions"
  | "improve";

export interface CrossLinkDef {
  from: string;
  to: CrossLinkKind;
  label: string;
  href: (params: Record<string, string | undefined>) => string;
}

/** Observe filter / time keys preserved across Eval ↔ Trace round-trips. */
export type TracePreserveParams = {
  q?: string;
  pastHours?: string;
  realm?: string;
  outcome?: string;
  agent_id?: string;
  view?: string;
};

function applyPreserve(q: URLSearchParams, preserve?: TracePreserveParams): void {
  if (!preserve) return;
  if (preserve.q) q.set("q", preserve.q);
  if (preserve.pastHours) q.set("pastHours", preserve.pastHours);
  if (preserve.realm) q.set("realm", preserve.realm);
  if (preserve.outcome) q.set("outcome", preserve.outcome);
  if (preserve.agent_id) q.set("agent_id", preserve.agent_id);
  if (preserve.view) q.set("view", preserve.view);
}

/** Read Observe preserve keys from URL search params (Alert/Issue → Traces). */
export function preserveFromSearchParams(
  sp: { get(name: string): string | null },
): TracePreserveParams | undefined {
  const out: TracePreserveParams = {};
  const q = sp.get("q");
  const pastHours = sp.get("pastHours");
  const realm = sp.get("realm");
  const outcome = sp.get("outcome");
  const agent_id = sp.get("agent_id");
  const view = sp.get("view");
  if (q) out.q = q;
  if (pastHours) out.pastHours = pastHours;
  if (realm) out.realm = realm;
  if (outcome) out.outcome = outcome;
  if (agent_id) out.agent_id = agent_id;
  if (view) out.view = view;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Later sources overwrite earlier for the same key. */
export function mergeTracePreserve(
  ...sources: Array<TracePreserveParams | undefined | null>
): TracePreserveParams | undefined {
  const out: TracePreserveParams = {};
  for (const src of sources) {
    if (!src) continue;
    if (src.q) out.q = src.q;
    if (src.pastHours) out.pastHours = src.pastHours;
    if (src.realm) out.realm = src.realm;
    if (src.outcome) out.outcome = src.outcome;
    if (src.agent_id) out.agent_id = src.agent_id;
    if (src.view) out.view = src.view;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Pull TracePreserveParams from alert/issue metadata when present. */
export function preserveFromRecord(
  meta?: Record<string, unknown> | null,
): TracePreserveParams | undefined {
  if (!meta) return undefined;
  const out: TracePreserveParams = {};
  for (const key of ["q", "pastHours", "realm", "outcome", "agent_id", "view"] as const) {
    const v = meta[key];
    if (typeof v === "string" && v.trim()) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function traceHref(
  traceId: string,
  preserve?: TracePreserveParams,
  opts?: { spanId?: string },
): string {
  const q = new URLSearchParams();
  q.set("traceId", traceId);
  if (opts?.spanId) q.set("spanId", opts.spanId);
  applyPreserve(q, preserve);
  return `/traces?${q.toString()}`;
}

/**
 * Ask/Chat citation → Trace deep link (Wave 6 closed loop).
 * Span cites jump via `?spanId=`; trace cites open the trace only.
 */
export function citationJumpHref(cite: {
  kind: string;
  id: string;
  trace_id?: string;
}): string | null {
  if (cite.kind === "span") {
    const tid = cite.trace_id?.trim();
    if (!tid) return null;
    return traceHref(tid, undefined, { spanId: cite.id });
  }
  if (cite.kind === "trace") {
    return traceHref(cite.id);
  }
  if (cite.kind === "incident") {
    return `/issues/${encodeURIComponent(cite.id)}`;
  }
  if (cite.trace_id) {
    return traceHref(cite.trace_id);
  }
  return null;
}

/** Session detail with optional Observe filter preserve (hub → session round-trip). */
export function sessionHref(
  sessionId: string,
  preserve?: TracePreserveParams,
): string {
  const q = new URLSearchParams();
  applyPreserve(q, preserve);
  const qs = q.toString();
  return `/sessions/${encodeURIComponent(sessionId)}${qs ? `?${qs}` : ""}`;
}

export function issueHref(issueId: string): string {
  return `/issues?issueId=${encodeURIComponent(issueId)}`;
}

export function issueFullHref(issueId: string): string {
  return `/issues/${encodeURIComponent(issueId)}`;
}

/** Improve queue deep link — Issue → Trace → Improve loop (Wave 5 / Wave 7). */
export function improveHref(issueId?: string): string {
  if (issueId) return `/improve?issue=${encodeURIComponent(issueId)}`;
  return "/improve";
}

export function artifactHref(artifactId?: string): string {
  if (artifactId) {
    return `/improve?tab=artifacts&artifactId=${encodeURIComponent(artifactId)}`;
  }
  return "/improve?tab=artifacts";
}

export function playgroundHref(
  traceId?: string,
  spanId?: string,
  preserve?: TracePreserveParams,
): string {
  const q = new URLSearchParams({ tab: "playgrounds" });
  if (traceId) q.set("trace_id", traceId);
  if (spanId) q.set("span_id", spanId);
  applyPreserve(q, preserve);
  return `/evals?${q.toString()}`;
}

/** Prompts registry deep link (Improve core). */
export function promptHref(name?: string): string {
  if (!name) return "/prompts";
  return `/prompts?prompt=${encodeURIComponent(name)}`;
}

/**
 * Iterate a prompt in Evaluate playground (Wave 5 / Wave 9).
 * Passes `prompt` as registry **name** (same as `promptHref`); playground
 * consumes `?prompt=` to prefill the active task system template.
 */
export function promptPlaygroundHref(promptName?: string): string {
  const q = new URLSearchParams({ tab: "playgrounds" });
  if (promptName) q.set("prompt", promptName);
  return `/evals?${q.toString()}`;
}

/** Plans list / detail deep links (Improve hub + standalone). */
export function improvePlansHref(planId?: string): string {
  if (planId) return `/improve/plans/${encodeURIComponent(planId)}`;
  return "/improve?tab=plans";
}

/** Sweep history (Improve hub History tab). */
export function improveHistoryHref(): string {
  return "/improve?tab=history";
}

/** Promote a production trace into a dataset while keeping Observe context. */
export function promoteTraceToDatasetHref(
  traceId: string,
  preserve?: TracePreserveParams,
): string {
  const q = new URLSearchParams({ tab: "datasets", promote_trace: traceId });
  applyPreserve(q, preserve);
  return `/evals?${q.toString()}`;
}

/**
 * Batch Add-to-dataset (M7) — comma-separated `promote_traces`.
 * Datasets tab runs N× `promoteFromTrace` (no bulk endpoint).
 */
export function promoteTracesToDatasetHref(
  traceIds: string[],
  preserve?: TracePreserveParams,
): string {
  const ids = [...new Set(traceIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return "/evals?tab=datasets";
  if (ids.length === 1) return promoteTraceToDatasetHref(ids[0]!, preserve);
  const q = new URLSearchParams({
    tab: "datasets",
    promote_traces: ids.join(","),
  });
  applyPreserve(q, preserve);
  return `/evals?${q.toString()}`;
}

/** Parse promote_trace / promote_traces query into unique trace ids. */
export function parsePromoteTraceIds(
  sp: URLSearchParams | { get: (key: string) => string | null },
): string[] {
  const single = sp.get("promote_trace")?.trim();
  const batch = sp.get("promote_traces")?.trim();
  const ids: string[] = [];
  if (single) ids.push(single);
  if (batch) {
    for (const part of batch.split(",")) {
      const id = part.trim();
      if (id) ids.push(id);
    }
  }
  return [...new Set(ids)];
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
  return "/improve?tab=ledger";
}

export function driftHref(agentId: string, dimension?: string): string {
  const q = dimension ? `?dimension=${encodeURIComponent(dimension)}` : "";
  return `/agents/${encodeURIComponent(agentId)}/drift${q}`;
}

export function tracesFilteredHref(filters: {
  agent_id?: string;
  outcome?: string;
  dimension?: string;
  pastHours?: string;
  q?: string;
  realm?: string;
}): string {
  const q = new URLSearchParams();
  if (filters.agent_id) q.set("agent_id", filters.agent_id);
  if (filters.outcome) q.set("outcome", filters.outcome);
  if (filters.dimension) q.set("q", `dimension:${filters.dimension}`);
  else if (filters.q) q.set("q", filters.q);
  if (filters.pastHours) q.set("pastHours", filters.pastHours);
  if (filters.realm) q.set("realm", filters.realm);
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

/** Promotions nest under Ledger (Wave 3) — deep links preserve inbox UX. */
export function promotionsHref(): string {
  return "/ledger?tab=promotions";
}

/** Required cross-link matrix entries (U19 §3) — used by CI tests. */
export const CROSS_LINK_MATRIX: CrossLinkDef[] = [
  { from: "trace", to: "issue", label: "View issue", href: (p) => issueHref(p.id!) },
  { from: "trace", to: "artifact", label: "Create artifact", href: () => artifactHref() },
  { from: "trace", to: "playground", label: "Open span", href: (p) => playgroundHref(p.traceId, p.spanId) },
  { from: "trace", to: "dataset", label: "Add to dataset", href: (p) =>
      p.traceId ? promoteTraceToDatasetHref(p.traceId) : datasetHref(),
  },
  { from: "trace", to: "labeling", label: "Seed queue", href: () => labelingQueueHref() },
  { from: "issue", to: "experiment", label: "Run experiment", href: (p) => experimentHref(undefined, p.id) },
  { from: "issue", to: "artifact", label: "Create artifact", href: () => artifactHref() },
  {
    from: "issue",
    to: "trace",
    label: "Open evidence trace",
    href: (p) =>
      p.traceId
        ? traceHref(p.traceId, {
            q: p.q,
            pastHours: p.pastHours,
            realm: p.realm,
            outcome: p.outcome,
            agent_id: p.agent_id,
            view: p.view,
          })
        : "/traces",
  },
  {
    from: "issue",
    to: "improve",
    label: "Open Improve",
    href: (p) => improveHref(p.id),
  },
  {
    from: "trace",
    to: "improve",
    label: "Open Improve",
    href: () => improveHref(),
  },
  {
    from: "alert",
    to: "improve",
    label: "Open Improve",
    href: () => improveHref(),
  },
  {
    from: "prompt",
    to: "playground",
    label: "Open in Playground",
    href: (p) => promptPlaygroundHref(p.name ?? p.id),
  },
  {
    from: "prompt",
    to: "improve",
    label: "Improve queue",
    href: () => improveHref(),
  },
  {
    from: "artifact",
    to: "improve",
    label: "Queue",
    href: () => improveHref(),
  },
  { from: "alert", to: "incident", label: "View incident", href: () => incidentHref() },
  {
    from: "alert",
    to: "trace",
    label: "Example traces",
    href: (p) =>
      p.traceId
        ? traceHref(p.traceId, {
            q: p.q,
            pastHours: p.pastHours,
            realm: p.realm,
            outcome: p.outcome,
            agent_id: p.agent_id,
          })
        : tracesFilteredHref({
            q: p.q,
            pastHours: p.pastHours,
            realm: p.realm,
            outcome: p.outcome,
            agent_id: p.agent_id,
          }),
  },
  { from: "artifact", to: "trace", label: "Outcomes", href: (p) => tracesFilteredHref({ agent_id: p.agentId }) },
  { from: "drift", to: "trace", label: "Show traces", href: (p) => tracesFilteredHref({ agent_id: p.agentId, dimension: p.dimension }) },
  { from: "dataset", to: "playground", label: "Run playground", href: () => playgroundHref() },
  { from: "dataset", to: "experiment", label: "Run experiment", href: () => experimentHref() },
  { from: "experiment", to: "trace", label: "Datapoint traces", href: (p) =>
      traceHref(p.traceId ?? "", {
        q: p.q,
        pastHours: p.pastHours,
        realm: p.realm,
        outcome: p.outcome,
        agent_id: p.agent_id,
      }),
  },
];
