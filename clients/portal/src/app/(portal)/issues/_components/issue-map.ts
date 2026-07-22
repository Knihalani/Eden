import type { AgentIssue, AgentStumble } from "@/lib/api";
import {
  preserveObserveFilters,
  writeObserveIdParam,
} from "@/lib/observe-url";

export type IssuesTab = "open" | "all" | "incidents";

export type IssueRow = {
  issueId: string;
  title: string;
  status: string;
  severity: string;
  agentId: string | null;
  occurrenceCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  fingerprint: string;
  kind: string;
};

export type FindingRow = {
  findingId: string;
  kind: string;
  message: string;
  severity: string;
  traceId?: string;
  spanId?: string;
};

const TERMINAL_STATUSES = new Set(["resolved", "closed", "ignored"]);

export function mapIssue(raw: AgentIssue): IssueRow {
  return {
    issueId: raw.id,
    title: raw.title,
    status: raw.status,
    severity: normalizeSeverity(raw.severity),
    agentId: raw.agent_id,
    occurrenceCount: raw.stumble_count,
    firstSeenAt: raw.first_seen ?? null,
    lastSeenAt: raw.last_seen ?? null,
    fingerprint: raw.fingerprint,
    kind: raw.kind,
  };
}

export function mapStumbleToFinding(raw: AgentStumble): FindingRow {
  return {
    findingId: raw.id,
    kind: raw.kind,
    message: raw.title,
    severity: normalizeSeverity(raw.severity),
    traceId: raw.trace_id || undefined,
    spanId: raw.span_id ?? undefined,
  };
}

export function normalizeSeverity(raw: string): string {
  const s = (raw || "med").toLowerCase();
  if (s === "medium") return "med";
  if (s === "p0" || s === "sev0") return "critical";
  if (s === "p1" || s === "sev1") return "high";
  if (s === "p2" || s === "sev2") return "med";
  if (s === "p3" || s === "sev3") return "low";
  return s;
}

export function isOpenIssueStatus(status: string): boolean {
  return !TERMINAL_STATUSES.has(status.toLowerCase());
}

export function parseIssuesTab(raw: string | undefined): IssuesTab {
  if (raw === "all" || raw === "incidents") return raw;
  return "open";
}

/** Clustered lens: occurrence count ≥ 2. */
export function isIncidentCluster(row: IssueRow): boolean {
  return row.occurrenceCount >= 2;
}

export function hasPlanEvidence(findings: FindingRow[]): boolean {
  return findings.some((f) => Boolean(f.traceId));
}

/** C3: one-click Open Trace, preserving observe filter set. */
export function buildOpenTraceHref(
  from: URLSearchParams,
  traceId: string,
  spanId?: string,
): string {
  const params = preserveObserveFilters(from);
  writeObserveIdParam(params, "traceId", traceId);
  writeObserveIdParam(params, "spanId", spanId);
  const qs = params.toString();
  return qs ? `/traces?${qs}` : `/traces?traceId=${encodeURIComponent(traceId)}`;
}

/** C4: Create Improve Plan with issueId + evidence trace ids. */
export function buildCreatePlanHref(
  issueId: string,
  findings: FindingRow[],
): string {
  const params = new URLSearchParams();
  params.set("issueId", issueId);
  params.set("tab", "plans");
  const traces = [
    ...new Set(findings.map((f) => f.traceId).filter(Boolean) as string[]),
  ];
  if (traces.length > 0) {
    params.set("traceId", traces[0]!);
    params.set("evidence", traces.join(","));
  }
  return `/improve?${params.toString()}`;
}

export function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const delta = Date.now() - ms;
  const mins = Math.round(delta / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** SeverityBadge class keys use `medium`, not `med`. */
export function severityBadgeKey(severity: string): string {
  return severity === "med" ? "medium" : severity;
}
