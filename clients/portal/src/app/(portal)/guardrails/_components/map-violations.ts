/**
 * Map scan-history rows into violation list rows (surfaces/guardrails.md §12).
 */

import type { GuardrailsSeverity } from "@/lib/guardrails-url";

export type ScanHistoryRow = {
  id: string;
  trace_id: string | null;
  verdict: string;
  reason: string | null;
  policy_id: string | null;
  edited_text: string | null;
  created_at: string;
  action?: string;
  agent_id?: string | null;
};

export type ViolationRow = {
  violationId: string;
  policyId: string | null;
  agentId: string | null;
  traceId: string | null;
  action: string;
  severity: GuardrailsSeverity | string;
  payload: string;
  createdAt: string;
};

const SEVERITY_ALIASES: Record<string, GuardrailsSeverity> = {
  block: "block",
  blocked: "block",
  deny: "block",
  deny_all: "block",
  warn: "warn",
  warning: "warn",
  log: "log",
  allow: "log",
  redact: "warn",
};

export function mapScanToViolation(scan: ScanHistoryRow): ViolationRow {
  const verdict = String(scan.verdict ?? "").toLowerCase();
  const action = String(scan.action ?? scan.verdict ?? "block");
  const severity =
    SEVERITY_ALIASES[verdict] ??
    SEVERITY_ALIASES[action.toLowerCase()] ??
    "block";

  return {
    violationId: String(scan.id),
    policyId: scan.policy_id ? String(scan.policy_id) : null,
    agentId: scan.agent_id ? String(scan.agent_id) : null,
    traceId: scan.trace_id ? String(scan.trace_id) : null,
    action,
    severity,
    payload: String(scan.reason ?? scan.edited_text ?? "").trim(),
    createdAt: String(scan.created_at ?? ""),
  };
}

export function filterViolations(
  rows: ViolationRow[],
  opts: {
    q?: string;
    agentId?: string;
    severity?: string;
    pastHours?: string;
    from?: string;
    to?: string;
  },
): ViolationRow[] {
  const q = opts.q?.trim().toLowerCase();
  const pastHours = opts.pastHours ? Number(opts.pastHours) : undefined;
  const fromMs = opts.from ? Date.parse(opts.from) : NaN;
  const toMs = opts.to ? Date.parse(opts.to) : NaN;
  const cutoff =
    pastHours && Number.isFinite(pastHours)
      ? Date.now() - pastHours * 3_600_000
      : undefined;

  return rows.filter((row) => {
    if (opts.agentId && row.agentId !== opts.agentId) return false;
    if (opts.severity && row.severity !== opts.severity) return false;

    if (q) {
      const hay = [
        row.violationId,
        row.policyId,
        row.agentId,
        row.traceId,
        row.action,
        row.payload,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }

    const ts = Date.parse(row.createdAt);
    if (Number.isFinite(ts)) {
      if (cutoff != null && ts < cutoff) return false;
      if (Number.isFinite(fromMs) && ts < fromMs) return false;
      if (Number.isFinite(toMs) && ts > toMs) return false;
    }

    return true;
  });
}

export type PolicyDraft = {
  name: string;
  description: string;
  kind: string;
  action: GuardrailsSeverity;
  enabled: boolean;
  rulesText: string;
  agentIds: string[];
  gatewayRoutes: string;
};

export function policyConfigFromDraft(draft: PolicyDraft): Record<string, unknown> {
  const routes = draft.gatewayRoutes
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

  let rules: unknown = draft.rulesText.trim();
  if (rules) {
    try {
      rules = JSON.parse(String(rules));
    } catch {
      rules = { notes: draft.rulesText.trim() };
    }
  } else {
    rules = {};
  }

  return {
    description: draft.description.trim() || undefined,
    rules,
    agentIds: draft.agentIds,
    gatewayRoutes: routes,
    enabled: draft.enabled,
  };
}

export function draftFromPolicy(policy: {
  name: string;
  kind: string;
  action: string;
  enabled: boolean;
  config: Record<string, unknown>;
}): PolicyDraft {
  const cfg = policy.config ?? {};
  const agentIds = Array.isArray(cfg.agentIds)
    ? cfg.agentIds.map(String)
    : Array.isArray(cfg.agent_ids)
      ? cfg.agent_ids.map(String)
      : [];
  const routesRaw = cfg.gatewayRoutes ?? cfg.gateway_routes ?? [];
  const gatewayRoutes = Array.isArray(routesRaw)
    ? routesRaw.map(String).join("\n")
    : String(routesRaw ?? "");
  const rules = cfg.rules;
  const rulesText =
    typeof rules === "string"
      ? rules
      : rules && typeof rules === "object"
        ? JSON.stringify(rules, null, 2)
        : "";

  const actionRaw = String(policy.action ?? "block").toLowerCase();
  const action: GuardrailsSeverity =
    actionRaw === "warn" || actionRaw === "log" ? actionRaw : "block";

  return {
    name: policy.name,
    description: String(cfg.description ?? ""),
    kind: policy.kind || "content",
    action,
    enabled: policy.enabled,
    rulesText,
    agentIds,
    gatewayRoutes,
  };
}
