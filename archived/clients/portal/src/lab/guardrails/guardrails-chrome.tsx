"use client";

import { StatusChip } from "@/components/ds/primitives";
import {
  actionLabel,
  GUARDRAIL_KINDS,
  GUARDRAIL_STATUSES,
  kindLabel,
  statusLabel,
  type GuardrailAction,
  type GuardrailKind,
  type GuardrailSeverity,
  type GuardrailStatus,
  type GuardrailTab,
} from "@/lab/fixtures/guardrails";

export function parseGuardrailTab(v: string | null): GuardrailTab {
  // Test dry-run is not wired — ignore legacy `?tab=test`.
  void v;
  return "policies";
}

/** Legacy portal kind labels from pre-FEAT-125 filters — map to canonical kinds. */
const LEGACY_GUARDRAIL_KIND_ALIASES: Record<string, GuardrailKind> = {
  pii: "pii_redaction",
  toxicity: "content_policy",
  tool_allowlist: "content_policy",
  rate_limit: "content_policy",
  custom: "content_policy",
};

export function parseGuardrailKindFilter(
  v: string | null,
): GuardrailKind | "all" {
  if (v && (GUARDRAIL_KINDS as readonly string[]).includes(v)) {
    return v as GuardrailKind;
  }
  const legacy = v ? LEGACY_GUARDRAIL_KIND_ALIASES[v] : undefined;
  return legacy ?? "all";
}

/** Portal status aliases normalized the same way as `_map_guardrail_status`. */
const GUARDRAIL_STATUS_ALIASES: Record<string, GuardrailStatus> = {
  enabled: "active",
  on: "active",
  dry_run: "shadow",
  "dry-run": "shadow",
  monitor: "shadow",
  inactive: "disabled",
  off: "disabled",
};

export function parseGuardrailStatusFilter(
  v: string | null,
): GuardrailStatus | "all" {
  if (v && (GUARDRAIL_STATUSES as readonly string[]).includes(v)) {
    return v as GuardrailStatus;
  }
  const alias = v ? GUARDRAIL_STATUS_ALIASES[v] : undefined;
  return alias ?? "all";
}

export function GuardrailKindChip({ kind }: { kind: GuardrailKind }) {
  return <StatusChip tone="neutral">{kindLabel(kind)}</StatusChip>;
}

export function GuardrailStatusChip({ status }: { status: GuardrailStatus }) {
  const tone =
    status === "active" ? "live" : status === "shadow" ? "neutral" : "neutral";
  return <StatusChip tone={tone}>{statusLabel(status)}</StatusChip>;
}

export function GuardrailActionChip({ action }: { action: GuardrailAction }) {
  const tone =
    action === "block" ? "fail" : action === "redact" ? "ok" : "neutral";
  return <StatusChip tone={tone}>{actionLabel(action)}</StatusChip>;
}

export function GuardrailSeverityChip({
  severity,
}: {
  severity?: GuardrailSeverity;
}) {
  if (!severity) return <StatusChip tone="neutral">—</StatusChip>;
  const tone =
    severity === "critical" || severity === "high" ? "fail" : "neutral";
  return <StatusChip tone={tone}>{severity}</StatusChip>;
}
