"use client";

interface GuardrailsKpiProps {
  policiesLength: number;
  enabledCount: number;
  statsPending: boolean;
}

/** Single non-redundant KPI strip — Policies count + enabled/disabled. */
export function GuardrailsKpi({
  policiesLength,
  enabledCount,
  statsPending,
}: GuardrailsKpiProps) {
  return (
    <div
      className="mb-space-4 flex flex-wrap gap-space-4 text-sm"
      data-testid="guardrails-kpi"
      data-wave10-guardrails="completed"
      data-wave4-guardrails="completed"
      data-wave6-improve-guardrails-kpi="ready"
    >
      <div>
        <p className="text-xs uppercase tracking-wider text-[var(--text-muted)]">
          Policies
        </p>
        <p className="text-lg font-semibold tabular-nums text-[var(--text-primary)]">
          {statsPending ? "—" : policiesLength}
        </p>
        <p className="text-xs text-[var(--text-muted)]">
          {statsPending
            ? "Loading…"
            : `${enabledCount} enabled · ${Math.max(0, policiesLength - enabledCount)} disabled`}
        </p>
      </div>
    </div>
  );
}
