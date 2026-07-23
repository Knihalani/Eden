/**
 * Guardrails fixtures — gateway policies + dry-run test hits.
 */

import { agentById } from "@/lab/fixtures/agents";
import { catalogGuardrailPolicies } from "@/lib/portal-catalog";

export type GuardrailKind =
  | "pii"
  | "toxicity"
  | "tool_allowlist"
  | "rate_limit"
  | "custom";

export type GuardrailStatus = "active" | "shadow" | "disabled";

export type GuardrailAction = "block" | "redact" | "flag";

export type GuardrailSeverity = "critical" | "high" | "medium" | "low";

export type GuardrailTab = "policies" | "test";

export type GuardrailPolicyFixture = {
  id: string;
  name: string;
  kind: GuardrailKind;
  status: GuardrailStatus;
  /** Omit / undefined = fleet-wide */
  agentId?: string;
  severity: GuardrailSeverity;
  matchCount24h: number;
  lastHit: string;
  ruleSummary: string;
  action: GuardrailAction;
  /** Related surfaces when a hit escalated */
  issueId?: string;
  traceIds?: string[];
};

export type GuardrailTestHit = {
  policyId: string;
  span: { start: number; end: number };
  excerpt: string;
  action: GuardrailAction;
  note: string;
};

export type GuardrailTestSample = {
  id: string;
  label: string;
  input: string;
  agentId?: string;
  hits: GuardrailTestHit[];
};

export const GUARDRAIL_POLICIES: GuardrailPolicyFixture[] = [];

export const GUARDRAIL_TEST_SAMPLES: GuardrailTestSample[] = [];

function livePolicies(): GuardrailPolicyFixture[] {
  const live = catalogGuardrailPolicies();
  return live.length > 0 ? live : GUARDRAIL_POLICIES;
}

export function policyById(
  id: string,
): GuardrailPolicyFixture | undefined {
  return livePolicies().find((p) => p.id === id);
}

export function policiesForAgent(
  agentId: string | "all",
): GuardrailPolicyFixture[] {
  if (agentId === "all") return livePolicies();
  return livePolicies().filter(
    (p) => !p.agentId || p.agentId === agentId,
  );
}

export function defaultPolicyId(agentId: string | "all"): string {
  const list = policiesForAgent(agentId);
  const active = list.find((p) => p.status === "active");
  return active?.id ?? list[0]?.id ?? livePolicies()[0]?.id ?? "";
}

export function testSampleById(
  id: string,
): GuardrailTestSample | undefined {
  return GUARDRAIL_TEST_SAMPLES.find((s) => s.id === id);
}

export function testSamplesForAgent(
  agentId: string | "all",
): GuardrailTestSample[] {
  if (agentId === "all") return GUARDRAIL_TEST_SAMPLES;
  return GUARDRAIL_TEST_SAMPLES.filter(
    (s) => !s.agentId || s.agentId === agentId,
  );
}

export function agentLabel(agentId?: string): string {
  if (!agentId) return "All agents";
  return agentById(agentId)?.name ?? agentId;
}

export function kindLabel(kind: GuardrailKind): string {
  if (kind === "pii") return "PII";
  if (kind === "toxicity") return "Toxicity";
  if (kind === "tool_allowlist") return "Tools";
  if (kind === "rate_limit") return "Rate";
  return "Custom";
}

export function statusLabel(status: GuardrailStatus): string {
  if (status === "active") return "active";
  if (status === "shadow") return "shadow";
  return "off";
}

export function actionLabel(action: GuardrailAction): string {
  if (action === "block") return "Block";
  if (action === "redact") return "Redact";
  return "Flag";
}

export function severityLabel(severity: GuardrailSeverity): string {
  return severity;
}

export function matchesLine(p: GuardrailPolicyFixture): string {
  if (p.matchCount24h <= 0) return "0 hits / 24h";
  return `${p.matchCount24h} hits / 24h · last ${p.lastHit}`;
}

export function labGuardrailsHref(params: {
  id?: string;
  agent?: string;
  tab?: GuardrailTab;
}): string {
  const q = new URLSearchParams();
  if (params.tab && params.tab !== "policies") q.set("tab", params.tab);
  if (params.id) q.set("id", params.id);
  if (params.agent) q.set("agent", params.agent);
  const qs = q.toString();
  return qs ? `/guardrails?${qs}` : "/guardrails";
}
