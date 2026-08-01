"use client";

import { StatusChip } from "@/components/ds/primitives";
import {
  actionLabel,
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

export function parseGuardrailKindFilter(
  v: string | null,
): GuardrailKind | "all" {
  if (
    v === "pii" ||
    v === "toxicity" ||
    v === "tool_allowlist" ||
    v === "rate_limit" ||
    v === "custom"
  ) {
    return v;
  }
  return "all";
}

export function parseGuardrailStatusFilter(
  v: string | null,
): GuardrailStatus | "all" {
  if (v === "active" || v === "shadow" || v === "disabled") return v;
  return "all";
}

/** Policies-only nav — Test dry-run is not a live surface. */
export function GuardrailsTabNav({
  value,
  onChange,
}: {
  value: GuardrailTab;
  onChange: (next: GuardrailTab) => void;
}) {
  return (
    <div role="tablist" aria-label="Guardrails sections" className="flex gap-1">
      <button
        type="button"
        role="tab"
        aria-selected={value === "policies"}
        className="ds-tab"
        onClick={() => onChange("policies")}
      >
        Policies
      </button>
    </div>
  );
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
  severity: GuardrailSeverity;
}) {
  const tone =
    severity === "critical" || severity === "high" ? "fail" : "neutral";
  return <StatusChip tone={tone}>{severity}</StatusChip>;
}
