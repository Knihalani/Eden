/** Field contracts — surfaces/alerts.md §12 */

export type AlertStatus = "open" | "acked" | "silenced" | "resolved";

export type AlertRow = {
  alertId: string;
  ruleId?: string;
  title: string;
  severity: string;
  status: AlertStatus;
  firedAt: string;
  agentId?: string;
  traceId?: string;
  issueId?: string;
  message: string;
  payload: Record<string, unknown>;
  channels: string[];
};

export type RuleRow = {
  ruleId: string;
  name: string;
  enabled: boolean;
  type: "threshold" | "detector" | "composite";
  condition: string;
  window?: string;
  severity: string;
  agentScope?: string;
  channelRefs: string[];
  description?: string;
};

export type SignalRow = {
  signalId: string;
  kind: string;
  message: string;
  severity: string;
  createdAt: string;
  agentId?: string;
  traceId?: string;
  spanId?: string;
  clusterIssueId?: string;
  confidence?: number;
};

export type AlertsTab = "inbox" | "rules" | "signals";

export const ALERTS_TABS: readonly AlertsTab[] = [
  "inbox",
  "rules",
  "signals",
] as const;

export function parseAlertsTab(raw: string | null | undefined): AlertsTab {
  if (raw === "rules" || raw === "signals") return raw;
  return "inbox";
}

function metaString(
  metadata: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const v = metadata[key];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

export function mapApiAlert(raw: {
  alert_id: string;
  severity: string;
  title: string;
  description: string;
  source: string;
  entity_id: string;
  triggered_at: string;
  acknowledged: boolean;
  channels: string[];
  metadata: Record<string, unknown>;
}): AlertRow {
  const metadata = raw.metadata ?? {};
  const agentId =
    metaString(metadata, "agentId", "agent_id") ??
    (raw.entity_id ? raw.entity_id : undefined);
  return {
    alertId: raw.alert_id,
    ruleId: metaString(metadata, "ruleId", "rule_id"),
    title: raw.title,
    severity: (raw.severity || "info").toLowerCase(),
    status: raw.acknowledged ? "acked" : "open",
    firedAt: raw.triggered_at,
    agentId,
    traceId: metaString(metadata, "traceId", "trace_id", "trace"),
    issueId: metaString(metadata, "issueId", "issue_id", "incident_id"),
    message: raw.description || "",
    payload: metadata,
    channels: raw.channels ?? [],
  };
}

export function mapApiRule(raw: {
  rule_id: string;
  name: string;
  description: string;
  event_types: string[];
  severity_threshold: string;
  channels: string[];
  enabled: boolean;
}): RuleRow {
  const types = raw.event_types ?? [];
  const type: RuleRow["type"] =
    types.some((t) => /detector/i.test(t))
      ? "detector"
      : types.length > 1
        ? "composite"
        : "threshold";
  return {
    ruleId: raw.rule_id,
    name: raw.name,
    enabled: raw.enabled,
    type,
    condition: types.join(", ") || raw.description || "",
    severity: (raw.severity_threshold || "medium").toLowerCase(),
    channelRefs: raw.channels ?? [],
    description: raw.description,
  };
}

export function mapApiEvent(raw: {
  id: string;
  title: string;
  severity: string;
  triage_verdict: string | null;
  triage_reason: string | null;
  triage_confidence: number | null;
  incident_id: string | null;
  acknowledged: boolean;
  created_at: string;
  payload: Record<string, unknown>;
}): SignalRow {
  const payload = raw.payload ?? {};
  return {
    signalId: raw.id,
    kind: metaString(payload, "kind", "detector", "event_type") ?? "detector",
    message: raw.triage_reason || raw.title || "",
    severity: (raw.severity || "info").toLowerCase(),
    createdAt: raw.created_at,
    agentId: metaString(payload, "agentId", "agent_id"),
    traceId: metaString(payload, "traceId", "trace_id", "trace"),
    spanId: metaString(payload, "spanId", "span_id"),
    clusterIssueId:
      raw.incident_id ??
      metaString(payload, "issueId", "issue_id", "clusterIssueId"),
    confidence:
      typeof raw.triage_confidence === "number"
        ? raw.triage_confidence
        : undefined,
  };
}
