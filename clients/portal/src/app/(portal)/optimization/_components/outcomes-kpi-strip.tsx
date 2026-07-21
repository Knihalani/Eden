"use client";

/**
 * Outcomes health strip — Helicone-style KPI cells (not a card wall).
 * Em-dash while loading or on error (never false $0).
 */

function formatCurrency(n: number, opts?: { compact?: boolean }) {
  if (opts?.compact) {
    if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
    return `$${n.toFixed(2)}`;
  }
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function KpiCell({
  label,
  value,
  meta,
}: {
  label: string;
  value: string;
  meta: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums tracking-tight text-[var(--text-primary)]">
        {value}
      </p>
      <p className="mt-0.5 text-xs text-[var(--text-muted)]">{meta}</p>
    </div>
  );
}

export type OutcomesKpiStripProps = {
  totalRevenue: number;
  totalCost: number;
  roi: number | null;
  loading: boolean;
  unavailable: boolean;
};

export function OutcomesKpiStrip({
  totalRevenue,
  totalCost,
  roi,
  loading,
  unavailable,
}: OutcomesKpiStripProps) {
  const dash = loading || unavailable;
  return (
    <div
      data-testid="outcomes-kpi-strip"
      className="mb-space-4 grid grid-cols-1 gap-space-4 border-b border-[var(--border-subtle)] pb-space-4 sm:grid-cols-3"
      aria-label="Outcomes health"
    >
      <KpiCell
        label="Total value"
        value={dash ? "—" : formatCurrency(totalRevenue, { compact: true })}
        meta={unavailable ? "unavailable" : loading ? "Loading…" : "Tracked outcomes"}
      />
      <KpiCell
        label="Total cost"
        value={dash ? "—" : formatCurrency(totalCost, { compact: true })}
        meta={unavailable ? "unavailable" : loading ? "Loading…" : "Attributed"}
      />
      <KpiCell
        label="ROI"
        value={dash ? "—" : roi == null ? "—" : roi.toFixed(2)}
        meta={unavailable ? "unavailable" : loading ? "Loading…" : "Value / cost"}
      />
    </div>
  );
}
