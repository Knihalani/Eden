"use client";

import {
  Loader2,
  TrendingDown,
  TrendingUp,
  Trophy,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { ErrorState } from "@/components/ui/error-state";
import type { RecommendationDto, RunnerUpDto } from "@/lib/api";
import { cn } from "@/lib/utils";
import { findOpt, fmtUsd } from "./advisor-candidates";

export function RecommendationCard({ rec, loading, error }: {
  rec: RecommendationDto | null;
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
    return <ErrorState title="Recommendation failed" message={error} />;
  }
  if (!rec) return null;

  const opt = findOpt(rec.recommended_provider, rec.recommended_model_id);
  const hasSavings = rec.monthly_savings_usd != null && Math.abs(rec.monthly_savings_usd) > 0.005;
  const isSavingMoney = hasSavings && (rec.monthly_savings_usd ?? 0) > 0;
  const isSameAsCurrent = rec.current_model_id === rec.recommended_model_id;

  return (
    <Card className="overflow-hidden">
      <div className={cn(
        "border-b px-6 py-4",
        isSameAsCurrent
          ? "border-[var(--info)]/30 bg-[var(--info)]/5"
          : isSavingMoney
            ? "border-[var(--success)]/30 bg-[var(--success)]/5"
            : "border-[var(--warning)]/30 bg-[var(--warning)]/5",
      )}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {isSameAsCurrent ? (
                <Trophy className="h-4 w-4 text-[var(--info)]" />
              ) : isSavingMoney ? (
                <TrendingDown className="h-4 w-4 text-[var(--success)]" />
              ) : (
                <TrendingUp className="h-4 w-4 text-[var(--warning)]" />
              )}
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                {isSameAsCurrent
                  ? "Stay on current"
                  : isSavingMoney
                    ? "Recommended switch"
                    : "Higher cost, higher quality"}
              </span>
            </div>
            <div className="mt-1 truncate text-xl font-semibold text-[var(--text-primary)]">
              {opt?.label ?? rec.recommended_model_id}
            </div>
            <div className="text-sm text-[var(--text-muted)]">
              {rec.recommended_provider} · score{" "}
              <span className="tabular-nums font-medium text-[var(--text-primary)]">{rec.score.toFixed(2)}</span>
            </div>
          </div>
          {hasSavings && rec.monthly_savings_usd !== null && (
            <div className="shrink-0 text-right">
              <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                {rec.monthly_savings_usd > 0 ? "Monthly savings" : "Monthly cost"}
              </div>
              <div className={cn(
                "text-2xl font-semibold tabular-nums",
                rec.monthly_savings_usd > 0 ? "text-[var(--success)]" : "text-[var(--warning)]",
              )}>
                {fmtUsd(Math.abs(rec.monthly_savings_usd), { compact: true })}
              </div>
              {rec.current_model_id && rec.current_model_id !== rec.recommended_model_id && (
                <div className="text-xs text-[var(--text-muted)]">
                  vs {findOpt(rec.current_provider ?? "", rec.current_model_id)?.label ?? rec.current_model_id}
                </div>
              )}
            </div>
          )}
        </div>
        {rec.rationale && (
          <div className="mt-3 text-sm text-[var(--text-secondary)]">
            {rec.rationale}
          </div>
        )}
        {rec.empty_history && (
          <div className="mt-3 rounded-md border border-[var(--warning)]/20 bg-[var(--warning)]/5 px-3 py-2 text-xs text-[var(--text-secondary)]">
            <span className="font-medium">Based on a default workload</span> — we
            don&apos;t have enough usage history on your current model yet. Run a
            few hundred requests to get a real projection.
          </div>
        )}
      </div>

      {rec.runners_up.length > 0 && (
        <div className="px-6 py-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            Runners-up
          </div>
          <ul className="divide-y divide-[var(--border-default)]">
            {rec.runners_up.map((r) => (
              <RunnerUpRow key={`${r.provider}::${r.model_id}`} runner={r} />
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function RunnerUpRow({ runner }: { runner: RunnerUpDto }) {
  const opt = findOpt(runner.provider, runner.model_id);
  return (
    <li className="flex items-center justify-between gap-4 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <span className="tabular-nums text-xs text-[var(--text-muted)] w-10 text-right">
          {runner.score.toFixed(2)}
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-[var(--text-primary)]">
            {opt?.label ?? runner.model_id}
          </div>
          <div className="truncate text-xs text-[var(--text-muted)]">{runner.rationale}</div>
        </div>
      </div>
      <Badge variant="outline" className={cn("shrink-0 border text-2xs", opt?.color)}>
        {opt?.tier ?? runner.provider}
      </Badge>
    </li>
  );
}
