/**
 * Guardrails fixtures — gateway policies + dry-run test hits.
 */

import { agentById } from "@/lab/fixtures/agents";
import { catalogGuardrailPolicies } from "@/lib/portal-catalog";

/**
 * Canonical policy kinds — mirrors `VALID_POLICY_TYPES` in
 * `eden/guardrails/policy.py` and `kind` on portal cards from
 * `GET /orgs/{org}/portal/guardrails/policies` (FEAT-125).
 */
export const GUARDRAIL_KINDS = [
  "prompt_injection",
  "pii_redaction",
  "hallucination",
  "content_policy",
  "judge_link",
] as const;

export type GuardrailKind = (typeof GUARDRAIL_KINDS)[number];

/**
 * Portal card statuses from `_map_guardrail_status` in `portal.py`.
 * Backend `VALID_POLICY_STATUSES` only writes `active` / `disabled` on
 * `guardrail_policies` rows; `shadow` appears when the stored status (or
 * alias `dry_run` / `monitor`) is mapped on read.
 */
export const GUARDRAIL_STATUSES = ["active", "shadow", "disabled"] as const;

export type GuardrailStatus = (typeof GUARDRAIL_STATUSES)[number];

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
  severity?: GuardrailSeverity;
  /**
   * Populated by `GET /orgs/{org}/portal/guardrails/policies` from
   * `intervention_log` rows attributed to each policy (InterventionEngine
   * path only — FEAT-38). `lastHit` / `ruleSummary` are still not computed.
   */
  matchCount24h?: number;
  lastHit?: string;
  ruleSummary?: string;
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
  if (kind === "prompt_injection") return "Prompt injection";
  if (kind === "pii_redaction") return "PII redaction";
  if (kind === "hallucination") return "Hallucination";
  if (kind === "content_policy") return "Content policy";
  return "Judge link";
}

export function statusLabel(status: GuardrailStatus): string {
  if (status === "active") return "Active";
  if (status === "shadow") return "Shadow";
  return "Off";
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
  if (!p.matchCount24h || p.matchCount24h <= 0) return "0 hits / 24h";
  return `${p.matchCount24h} hits / 24h · last ${p.lastHit ?? "—"}`;
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
