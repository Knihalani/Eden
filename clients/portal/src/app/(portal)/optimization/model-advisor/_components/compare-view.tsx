"use client";

import {
  Scale,
  TrendingDown,
  TrendingUp,
  Loader2,
} from "lucide-react";

import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { ErrorState } from "@/components/ui/error-state";
import type { ModelComparisonDto, ModelSpecDto } from "@/lib/api";
import { cn } from "@/lib/utils";
import { findOpt, fmtUsd, fmtMs, fmtTokens } from "./advisor-candidates";

function SpecRow({ label, current, candidate, format, better }: {
  label: string;
  current: number;
  candidate: number;
  format: (n: number) => string;
  better: "higher" | "lower";
}) {
  const delta = candidate - current;
  const candIsBetter = better === "higher" ? delta > 0 : delta < 0;
  const arrowBetter = candIsBetter ? (
    <TrendingDown className="h-3 w-3 text-[var(--success)] rotate-180" />
  ) : delta === 0 ? null : (
    better === "higher" ? <TrendingDown className="h-3 w-3 text-[var(--error)]" /> : <TrendingUp className="h-3 w-3 text-[var(--error)]" />
  );
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 py-1.5 text-sm">
      <span className="text-right tabular-nums text-[var(--text-secondary)]">
        {format(current)}
      </span>
      <div className="flex flex-col items-center gap-0.5">
        <span className="text-xs font-medium text-[var(--text-muted)]">{label}</span>
        <div className="flex h-3 items-center gap-1">
          <span className={cn(
            "tabular-nums text-xs font-semibold",
            candIsBetter ? "text-[var(--success)]" : delta === 0 ? "text-[var(--text-secondary)]" : "text-[var(--error)]",
          )}>
            {delta === 0 ? "—" : `${delta > 0 ? "+" : ""}${format(delta)}`}
          </span>
          {arrowBetter}
        </div>
      </div>
      <span className={cn("tabular-nums", candIsBetter ? "font-semibold text-[var(--success)]" : "text-[var(--text-primary)]")}>
        {format(candidate)}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Spec card (current or candidate)
// ─────────────────────────────────────────────────────────────────────

function SpecCard({ spec, role, highlight }: {
  spec: ModelSpecDto;
  role: "current" | "candidate";
  highlight?: boolean;
}) {
  const opt = findOpt(spec.provider, spec.model_id);
  const tierBadge = (
    <Badge variant="outline" className={cn("border text-2xs uppercase tracking-wide", opt?.color)}>
      {opt?.tier ?? spec.source}
    </Badge>
  );
  return (
    <div className={cn(
      "rounded-lg border bg-[var(--bg-secondary)] p-4",
      highlight ? "border-[var(--accent)]" : "border-[var(--border-default)]",
    )}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
            {role === "current" ? "Currently using" : "Switch to"}
          </div>
          <div className="mt-0.5 truncate text-base font-semibold text-[var(--text-primary)]">
            {opt?.label ?? spec.model_id}
          </div>
          <div className="text-xs text-[var(--text-muted)]">{spec.provider}</div>
        </div>
        {tierBadge}
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
        <div>
          <dt className="text-xs text-[var(--text-muted)]">Quality</dt>
          <dd className="tabular-nums font-medium text-[var(--text-primary)]">
            {(spec.quality * 100).toFixed(0)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--text-muted)]">p95 latency</dt>
          <dd className="tabular-nums font-medium text-[var(--text-primary)]">{fmtMs(spec.latency_p95_ms)}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--text-muted)]">Reliability</dt>
          <dd className="tabular-nums font-medium text-[var(--text-primary)]">
            {(spec.reliability * 100).toFixed(1)}%
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--text-muted)]">Context</dt>
          <dd className="tabular-nums font-medium text-[var(--text-primary)]">
            {spec.context_window ? fmtTokens(spec.context_window) : "—"}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export function CompareView({ comparison, loading, error }: {
  comparison: ModelComparisonDto | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <Panel tone="flat" padding="lg" className="flex h-40 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
      </Panel>
    );
  }
  if (error) {
    return <ErrorState title="Compare failed" message={error} />;
  }
  if (!comparison) return null;

  const ratioIsFree = comparison.cost_ratio >= 1e8;

  return (
    <Panel tone="flat" padding="lg" className="space-y-space-4">
      <div>
        <h3 className="flex items-center gap-space-2 text-sm font-semibold text-[var(--text-primary)]">
          <Scale className="h-4 w-4 text-[var(--accent)]" />
          Side-by-side comparison
        </h3>
        <p className="mt-space-1 text-sm text-[var(--text-muted)]">
          {comparison.current.model_id} → {comparison.candidate.model_id}
        </p>
      </div>
      <div className="space-y-space-4">
        <div className="grid grid-cols-2 gap-space-3">
          <SpecCard spec={comparison.current} role="current" />
          <SpecCard spec={comparison.candidate} role="candidate" highlight />
        </div>

        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-tertiary)] p-4">
          <div className="mb-2 grid grid-cols-[1fr_auto_1fr] text-xs uppercase tracking-wide text-[var(--text-muted)]">
            <span className="text-right">Current</span>
            <span className="px-2">Metric</span>
            <span>Candidate</span>
          </div>
          <SpecRow
            label="Input $/1K"
            current={comparison.current.cost_per_1k_input}
            candidate={comparison.candidate.cost_per_1k_input}
            format={(n) => fmtUsd(n, { compact: true })}
            better="lower"
          />
          <SpecRow
            label="Output $/1K"
            current={comparison.current.cost_per_1k_output}
            candidate={comparison.candidate.cost_per_1k_output}
            format={(n) => fmtUsd(n, { compact: true })}
            better="lower"
          />
          <SpecRow
            label="p95 latency"
            current={comparison.current.latency_p95_ms}
            candidate={comparison.candidate.latency_p95_ms}
            format={fmtMs}
            better="lower"
          />
          <SpecRow
            label="Context tokens"
            current={comparison.current.context_window}
            candidate={comparison.candidate.context_window}
            format={fmtTokens}
            better="higher"
          />
          <SpecRow
            label="Quality"
            current={comparison.current.quality * 100}
            candidate={comparison.candidate.quality * 100}
            format={(n) => n.toFixed(0)}
            better="higher"
          />
          <SpecRow
            label="Reliability"
            current={comparison.current.reliability * 100}
            candidate={comparison.candidate.reliability * 100}
            format={(n) => `${n.toFixed(1)}%`}
            better="higher"
          />
        </div>

        <div className="flex items-center justify-between rounded-md border border-[var(--border-default)] px-4 py-2">
          <span className="text-sm text-[var(--text-muted)]">Blended cost ratio</span>
          <span className={cn(
            "tabular-nums text-base font-semibold",
            ratioIsFree ? "text-[var(--success)]" :
              comparison.cost_ratio < 1 ? "text-[var(--success)]" :
                comparison.cost_ratio > 1.2 ? "text-[var(--error)]" :
                  "text-[var(--text-primary)]",
          )}>
            {ratioIsFree ? "free" : `${comparison.cost_ratio.toFixed(2)}×`}
          </span>
        </div>
      </div>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Project view (switch projection + scale slider)
// ─────────────────────────────────────────────────────────────────────
