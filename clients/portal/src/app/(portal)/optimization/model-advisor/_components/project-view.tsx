"use client";

import {
  Loader2,
  Wallet,
} from "lucide-react";

import { Panel } from "@/components/ui/panel";
import { ErrorState } from "@/components/ui/error-state";
import type { SwitchProjectionDto } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtUsd, fmtPct } from "./advisor-candidates";

function KpiCell({
  label,
  value,
  meta,
  emphasize,
}: {
  label: string;
  value: string;
  meta?: string;
  emphasize?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
      <p
        className={cn(
          "mt-1 text-lg font-semibold tabular-nums tracking-tight",
          emphasize ? "text-[var(--terminal)]" : "text-[var(--text-primary)]",
        )}
      >
        {value}
      </p>
      {meta ? <p className="mt-0.5 text-xs text-[var(--text-muted)]">{meta}</p> : null}
    </div>
  );
}

export function ProjectView({ projection, loading, error, scaleFactor, onScale }: {
  projection: SwitchProjectionDto | null;
  loading: boolean;
  error: string | null;
  scaleFactor: number;
  onScale: (n: number) => void;
}) {
  if (loading) {
    return (
      <Panel tone="flat" padding="lg" className="flex h-40 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
      </Panel>
    );
  }
  if (error) {
    return <ErrorState title="Projection failed" message={error} />;
  }
  if (!projection) return null;

  const isSaving = projection.savings_usd > 0;
  const hasTraffic = projection.requests_in_window > 0;

  return (
    <Panel tone="flat" padding="lg" className="space-y-space-4">
      <div>
        <h3 className="flex items-center gap-space-2 text-sm font-semibold text-[var(--text-primary)]">
          <Wallet className="h-4 w-4 text-[var(--accent)]" />
          Cost projection
        </h3>
        <p className="mt-space-1 text-sm text-[var(--text-muted)]">
          {projection.current_model_id} → {projection.candidate_model_id}
          {" "}over the last {projection.window_days} days
        </p>
      </div>
        {/* Thin KPI strip — cost / projection glance metrics */}
        <div
          data-testid="advisor-project-kpi"
          className="grid grid-cols-2 gap-space-4 border-b border-[var(--border-subtle)] pb-space-4 sm:grid-cols-4"
          aria-label="Projection health"
        >
          <KpiCell
            label="Current bill"
            value={fmtUsd(projection.current_total_usd, { compact: true })}
          />
          <KpiCell
            label="Projected bill"
            value={fmtUsd(projection.projected_total_usd, { compact: true })}
            emphasize={isSaving}
          />
          <KpiCell
            label={isSaving ? "Monthly savings" : "Monthly cost"}
            value={fmtUsd(Math.abs(projection.savings_usd), { compact: true })}
            meta={fmtPct(projection.savings_pct)}
          />
          <KpiCell
            label="Cache savings"
            value={fmtUsd(projection.cache_savings_usd, { compact: true })}
            meta="vs no-cache rate"
          />
        </div>

        <div className="rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] p-space-4">
          <div className="mb-space-3 flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-[var(--text-primary)]">
                Scale: {scaleFactor.toFixed(1)}× current traffic
              </div>
              <div className="text-xs text-[var(--text-muted)]">
                What if your usage grew by this factor?
              </div>
            </div>
            <div className="text-right">
              <div className="text-sm font-medium tabular-nums text-[var(--text-primary)]">
                {hasTraffic
                  ? `${projection.requests_in_window.toLocaleString()} req`
                  : "No traffic"}
              </div>
              <div className="text-xs text-[var(--text-muted)]">last {projection.window_days} days</div>
            </div>
          </div>
          <input
            type="range"
            min={0.1}
            max={10}
            step={0.1}
            value={scaleFactor}
            onChange={(e) => onScale(parseFloat(e.target.value))}
            className="w-full accent-[var(--accent)]"
          />
          <div className="mt-1 flex justify-between text-2xs text-[var(--text-muted)] tabular-nums">
            <span>0.1×</span>
            <span>1×</span>
            <span>2×</span>
            <span>5×</span>
            <span>10×</span>
          </div>
        </div>

        {!hasTraffic && (
          <div className="rounded-md border border-[var(--warning)]/20 bg-[var(--warning)]/5 px-3 py-2 text-xs text-[var(--text-secondary)]">
            We don&apos;t have any <code className="font-mono">usage_events</code> rows on your current model in this window.
            The projection uses a default 1K input / 500 output workload per request.
          </div>
        )}
    </Panel>
  );
}
