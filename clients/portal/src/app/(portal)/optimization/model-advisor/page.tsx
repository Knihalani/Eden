"use client";

/**
 * Model Advisor — comparison + recommendation surface.
 *
 * Phase 7.6. The page exposes four affordances:
 *
 *   1. Pick mode — "which model is best for my agent?" given a
 *      curated candidate list. Pure quality/cost ranking.
 *   2. Switch mode — "if I swap my current model for X, what
 *      changes?". Reads the org's real usage_events for the last
 *      30 days and projects the bill.
 *   3. Compare — side-by-side deltas on every metric for two
 *      specific models.
 *   4. Project — projected cost at scale, including cache
 *      discount applied.
 *
 * Scoring is quality-first (60/25/10/5) so the page biases toward
 * "what would still work well" rather than "what's cheapest".
 */

import { useEffect, useMemo, useState } from "react";
import {
  Brain,
  ChevronDown,
  CircleDollarSign,
  Gauge,
  Loader2,
  Scale,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Trophy,
  Wallet,
  Zap,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useOrg } from "@/hooks/use-org";
import {
  modelAdvisorApi,
  type ModelComparisonDto,
  type ModelRefDto,
  type ModelSpecDto,
  type RecommendationDto,
  type RunnerUpDto,
  type SwitchProjectionDto,
} from "@/lib/api";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────
// Curated candidate catalogue (matches the backend seed)
// ─────────────────────────────────────────────────────────────────────

interface CandidateOption {
  provider: string;
  modelId: string;
  label: string;
  tier: "frontier" | "mid" | "budget" | "local";
  color: string;
}

const CANDIDATES: CandidateOption[] = [
  // OpenAI
  { provider: "openai",     modelId: "gpt-5",            label: "GPT-5",         tier: "frontier", color: "bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]/30" },
  { provider: "openai",     modelId: "gpt-5-mini",       label: "GPT-5 mini",    tier: "mid",      color: "bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]/30" },
  { provider: "openai",     modelId: "gpt-5-nano",       label: "GPT-5 nano",    tier: "budget",   color: "bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]/30" },
  { provider: "openai",     modelId: "gpt-4o",           label: "GPT-4o",        tier: "frontier", color: "bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]/30" },
  { provider: "openai",     modelId: "gpt-4o-mini",      label: "GPT-4o mini",   tier: "mid",      color: "bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]/30" },
  { provider: "openai",     modelId: "o3",               label: "o3 (reasoning)", tier: "frontier", color: "bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]/30" },
  { provider: "openai",     modelId: "o3-mini",          label: "o3-mini",       tier: "mid",      color: "bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]/30" },
  // Anthropic
  { provider: "anthropic",  modelId: "claude-opus-4-5",  label: "Claude Opus 4.5", tier: "frontier", color: "bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning)]/30" },
  { provider: "anthropic",  modelId: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", tier: "frontier", color: "bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning)]/30" },
  { provider: "anthropic",  modelId: "claude-haiku-4-5", label: "Claude Haiku 4.5", tier: "mid", color: "bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning)]/30" },
  // Google
  { provider: "google",     modelId: "gemini-3-pro",     label: "Gemini 3 Pro",  tier: "frontier", color: "bg-sky-500/10 text-sky-300 border-sky-500/30" },
  { provider: "google",     modelId: "gemini-2.5-flash", label: "Gemini 2.5 Flash", tier: "mid", color: "bg-sky-500/10 text-sky-300 border-sky-500/30" },
  // Local / self-hosted
  { provider: "ollama",     modelId: "llama3.1:8b",      label: "Llama 3.1 8B (local)", tier: "local", color: "bg-zinc-500/10 text-zinc-300 border-zinc-500/30" },
  { provider: "vllm",       modelId: "qwen2.5:32b",      label: "Qwen 2.5 32B (local)", tier: "local", color: "bg-zinc-500/10 text-zinc-300 border-zinc-500/30" },
];

const DEFAULT_CANDIDATE_IDS = [
  "openai::gpt-4o",
  "openai::gpt-4o-mini",
  "anthropic::claude-sonnet-4-6",
  "google::gemini-2.5-flash",
];

function optKey(c: CandidateOption): string {
  return `${c.provider}::${c.modelId}`;
}

function findOpt(provider: string, modelId: string): CandidateOption | undefined {
  return CANDIDATES.find((c) => c.provider === provider && c.modelId === modelId);
}

// ─────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────

function fmtUsd(n: number, opts: { compact?: boolean } = {}): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (opts.compact) {
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
    if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
    return `${sign}$${(abs * 100).toFixed(1)}¢`;
  }
  if (abs === 0) return "$0.00";
  if (abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
  if (abs < 1) return `${sign}$${abs.toFixed(3)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function fmtMs(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(2)}s`;
  return `${Math.round(n)}ms`;
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${Math.round(n)}`;
}

// ─────────────────────────────────────────────────────────────────────
// Spec row (used by the side-by-side compare card)
// ─────────────────────────────────────────────────────────────────────

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
    <Badge variant="outline" className={cn("border text-[10px] uppercase tracking-wide", opt?.color)}>
      {opt?.tier ?? spec.source}
    </Badge>
  );
  return (
    <div className={cn(
      "rounded-lg border bg-[var(--bg-secondary)] p-4",
      highlight ? "border-[var(--accent)] shadow-[var(--shadow-glow)]" : "border-[var(--border-default)]",
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

// ─────────────────────────────────────────────────────────────────────
// Recommendation card
// ─────────────────────────────────────────────────────────────────────

function RecommendationCard({ rec, loading, error }: {
  rec: RecommendationDto | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <Card>
        <CardContent className="flex h-40 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
        </CardContent>
      </Card>
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
      <Badge variant="outline" className={cn("shrink-0 border text-[10px]", opt?.color)}>
        {opt?.tier ?? runner.provider}
      </Badge>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Compare view (side-by-side deltas)
// ─────────────────────────────────────────────────────────────────────

function CompareView({ comparison, loading, error }: {
  comparison: ModelComparisonDto | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <Card>
        <CardContent className="flex h-40 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
        </CardContent>
      </Card>
    );
  }
  if (error) {
    return <ErrorState title="Compare failed" message={error} />;
  }
  if (!comparison) return null;

  const ratioIsFree = comparison.cost_ratio >= 1e8;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Scale className="h-4 w-4 text-[var(--accent)]" />
          Side-by-side comparison
        </CardTitle>
        <CardDescription>
          {comparison.current.model_id} → {comparison.candidate.model_id}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
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
            label="Quality"
            current={comparison.current.quality * 100}
            candidate={comparison.candidate.quality * 100}
            format={(n) => n.toFixed(0)}
            better="higher"
          />
          <SpecRow
            label="p95 latency"
            current={comparison.current.latency_p95_ms}
            candidate={comparison.candidate.latency_p95_ms}
            format={fmtMs}
            better="lower"
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
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Project view (switch projection + scale slider)
// ─────────────────────────────────────────────────────────────────────

function ProjectView({ projection, loading, error, scaleFactor, onScale }: {
  projection: SwitchProjectionDto | null;
  loading: boolean;
  error: string | null;
  scaleFactor: number;
  onScale: (n: number) => void;
}) {
  if (loading) {
    return (
      <Card>
        <CardContent className="flex h-40 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
        </CardContent>
      </Card>
    );
  }
  if (error) {
    return <ErrorState title="Projection failed" message={error} />;
  }
  if (!projection) return null;

  const isSaving = projection.savings_usd > 0;
  const hasTraffic = projection.requests_in_window > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-[var(--accent)]" />
          Cost projection
        </CardTitle>
        <CardDescription>
          {projection.current_model_id} → {projection.candidate_model_id}
          {" "}over the last {projection.window_days} days
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            title="Current bill"
            value={fmtUsd(projection.current_total_usd, { compact: true })}
            icon={CircleDollarSign}
            accent="neutral"
          />
          <StatCard
            title="Projected bill"
            value={fmtUsd(projection.projected_total_usd, { compact: true })}
            icon={CircleDollarSign}
            accent={isSaving ? "accent" : "warning"}
          />
          <StatCard
            title={isSaving ? "Monthly savings" : "Monthly cost"}
            value={fmtUsd(Math.abs(projection.savings_usd), { compact: true })}
            trend={isSaving ? "down" : "up"}
            trendValue={fmtPct(projection.savings_pct)}
            trendIsGood={isSaving ? "down" : "up"}
            icon={isSaving ? TrendingDown : TrendingUp}
            accent={isSaving ? "accent" : "warning"}
          />
          <StatCard
            title="Cache savings"
            value={fmtUsd(projection.cache_savings_usd, { compact: true })}
            icon={Zap}
            accent="info"
            subtitle="vs no-cache rate"
          />
        </div>

        <div className="rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] p-4">
          <div className="mb-3 flex items-center justify-between">
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
          <div className="mt-1 flex justify-between text-[10px] text-[var(--text-muted)] tabular-nums">
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
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Model picker (multi-select via badges)
// ─────────────────────────────────────────────────────────────────────

function CandidatePicker({ selected, onChange }: {
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return CANDIDATES;
    return CANDIDATES.filter((c) =>
      c.label.toLowerCase().includes(f) ||
      c.provider.toLowerCase().includes(f) ||
      c.modelId.toLowerCase().includes(f),
    );
  }, [filter]);

  const selectedOpts = selected
    .map((k) => CANDIDATES.find((c) => optKey(c) === k))
    .filter((x): x is CandidateOption => x != null);

  function toggle(opt: CandidateOption) {
    const k = optKey(opt);
    if (selected.includes(k)) {
      onChange(selected.filter((s) => s !== k));
    } else {
      onChange([...selected, k]);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-left text-sm hover:border-[var(--border-strong)]"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          {selectedOpts.length === 0 && (
            <span className="text-[var(--text-muted)]">Select candidate models…</span>
          )}
          {selectedOpts.slice(0, 4).map((o) => (
            <Badge
              key={optKey(o)}
              variant="outline"
              className={cn("border text-[10px]", o.color)}
            >
              {o.label}
            </Badge>
          ))}
          {selectedOpts.length > 4 && (
            <span className="text-xs text-[var(--text-muted)]">
              +{selectedOpts.length - 4} more
            </span>
          )}
        </div>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform", open && "rotate-180")} />
      </button>
      <>
        {open && (
          <div
            className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] shadow-lg"
          >
            <div className="border-b border-[var(--border-default)] p-2">
              <Input
                autoFocus
                placeholder="Filter models…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-8"
              />
            </div>
            <ul className="max-h-64 overflow-y-auto py-1">
              {filtered.length === 0 && (
                <li className="px-3 py-2 text-sm text-[var(--text-muted)]">No matches.</li>
              )}
              {filtered.map((o) => {
                const k = optKey(o);
                const isSelected = selected.includes(k);
                return (
                  <li key={k}>
                    <button
                      type="button"
                      onClick={() => toggle(o)}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                        isSelected ? "bg-[var(--accent-faint)]" : "hover:bg-[var(--bg-tertiary)]",
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={cn(
                          "inline-flex h-4 w-4 items-center justify-center rounded border",
                          isSelected
                            ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--bg-primary)]"
                            : "border-[var(--border-strong)]",
                        )}>
                          {isSelected && <span className="text-[10px]">✓</span>}
                        </span>
                        <span className="truncate text-[var(--text-primary)]">{o.label}</span>
                      </div>
                      <Badge variant="outline" className={cn("shrink-0 border text-[10px]", o.color)}>
                        {o.tier}
                      </Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────

export default function ModelAdvisorPage() {
  const { currentOrg } = useOrg();

  // Form state
  const [mode, setMode] = useState<"pick" | "switch">("switch");
  const [currentKey, setCurrentKey] = useState<string>(
    "openai::gpt-4o",
  );
  const [candidateKeys, setCandidateKeys] = useState<string[]>(DEFAULT_CANDIDATE_IDS);
  const [windowDays, setWindowDays] = useState<number>(30);
  const [scaleFactor, setScaleFactor] = useState<number>(1);

  // Loading / error
  const [recLoading, setRecLoading] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const [cmpLoading, setCmpLoading] = useState(false);
  const [cmpError, setCmpError] = useState<string | null>(null);
  const [projLoading, setProjLoading] = useState(false);
  const [projError, setProjError] = useState<string | null>(null);

  // Results
  const [recommendation, setRecommendation] = useState<RecommendationDto | null>(null);
  const [comparison, setComparison] = useState<ModelComparisonDto | null>(null);
  const [projection, setProjection] = useState<SwitchProjectionDto | null>(null);

  // Trigger fetch when inputs change
  useEffect(() => {
    if (!currentOrg) return;
    if (candidateKeys.length === 0) {
      setRecommendation(null);
      return;
    }
    let cancelled = false;
    setRecLoading(true);
    setRecError(null);

    const candidateRefs: ModelRefDto[] = candidateKeys.map((k) => {
      const [provider, ...rest] = k.split("::");
      return { provider, model_id: rest.join("::") };
    });
    const currentRef: ModelRefDto | null =
      mode === "switch" && currentKey
        ? (() => {
            const [provider, ...rest] = currentKey.split("::");
            return { provider, model_id: rest.join("::") };
          })()
        : null;

    modelAdvisorApi
      .recommend(currentOrg.id, {
        mode,
        candidates: candidateRefs,
        current: currentRef ?? undefined,
        window_days: windowDays,
      })
      .then((rec) => {
        if (cancelled) return;
        setRecommendation(rec);
      })
      .catch((e) => {
        if (cancelled) return;
        setRecError(e instanceof Error ? e.message : "Failed to load recommendation");
      })
      .finally(() => {
        if (!cancelled) setRecLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentOrg?.id, mode, currentKey, candidateKeys.join("|"), windowDays]);

  // Compare effect
  useEffect(() => {
    if (!currentOrg) return;
    if (mode !== "switch" || !currentKey) {
      setComparison(null);
      return;
    }
    const candidateKey = candidateKeys[0] ?? currentKey;
    if (candidateKey === currentKey) {
      setComparison(null);
      return;
    }
    let cancelled = false;
    setCmpLoading(true);
    setCmpError(null);

    const [curP, ...curRest] = currentKey.split("::");
    const [candP, ...candRest] = candidateKey.split("::");

    modelAdvisorApi
      .compare(currentOrg.id, {
        current: { provider: curP, model_id: curRest.join("::") },
        candidate: { provider: candP, model_id: candRest.join("::") },
      })
      .then((c) => {
        if (cancelled) return;
        setComparison(c);
      })
      .catch((e) => {
        if (cancelled) return;
        setCmpError(e instanceof Error ? e.message : "Failed to compare");
      })
      .finally(() => {
        if (!cancelled) setCmpLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentOrg?.id, mode, currentKey, candidateKeys.join("|")]);

  // Project effect (re-fires on scale change)
  useEffect(() => {
    if (!currentOrg) return;
    if (mode !== "switch" || !currentKey) {
      setProjection(null);
      return;
    }
    const candidateKey = candidateKeys[0] ?? currentKey;
    if (candidateKey === currentKey) {
      setProjection(null);
      return;
    }
    let cancelled = false;
    setProjLoading(true);
    setProjError(null);

    const [curP, ...curRest] = currentKey.split("::");
    const [candP, ...candRest] = candidateKey.split("::");

    modelAdvisorApi
      .project(currentOrg.id, {
        current: { provider: curP, model_id: curRest.join("::") },
        candidate: { provider: candP, model_id: candRest.join("::") },
        scale_factor: scaleFactor,
        window_days: windowDays,
      })
      .then((p) => {
        if (cancelled) return;
        setProjection(p);
      })
      .catch((e) => {
        if (cancelled) return;
        setProjError(e instanceof Error ? e.message : "Failed to project");
      })
      .finally(() => {
        if (!cancelled) setProjLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentOrg?.id, mode, currentKey, candidateKeys.join("|"), scaleFactor, windowDays]);

  if (!currentOrg) {
    return <NoOrgState feature="Model advisor" />;
  }

  return (
    <PageContent size="wide">
      <PageHeader
        eyebrow="Optimize"
        title="Model advisor"
        subtitle="Compare models, project the cost of a switch, and pick the best one for your workload."
        icon={Brain}
      />

      {/* ── Form ───────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--text-secondary)]">Mode</span>
              <div className="inline-flex rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] p-0.5">
                <button
                  type="button"
                  onClick={() => setMode("switch")}
                  className={cn(
                    "rounded px-3 py-1 text-sm transition-colors",
                    mode === "switch"
                      ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                  )}
                >
                  Switch from current
                </button>
                <button
                  type="button"
                  onClick={() => setMode("pick")}
                  className={cn(
                    "rounded px-3 py-1 text-sm transition-colors",
                    mode === "pick"
                      ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                  )}
                >
                  Fresh pick
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--text-secondary)]">Window</span>
              <Select
                value={String(windowDays)}
                onValueChange={(v) => setWindowDays(parseInt(v, 10))}
              >
                <SelectTrigger className="h-8 w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">7 days</SelectItem>
                  <SelectItem value="14">14 days</SelectItem>
                  <SelectItem value="30">30 days</SelectItem>
                  <SelectItem value="60">60 days</SelectItem>
                  <SelectItem value="90">90 days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {mode === "switch" && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                  Currently using
                </label>
                <Select value={currentKey} onValueChange={setCurrentKey}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CANDIDATES.map((o) => (
                      <SelectItem key={optKey(o)} value={optKey(o)}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                  Candidates
                </label>
                <CandidatePicker selected={candidateKeys} onChange={setCandidateKeys} />
              </div>
            </div>
          )}

          {mode === "pick" && (
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                Candidates
              </label>
              <CandidatePicker selected={candidateKeys} onChange={setCandidateKeys} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Recommendation (always shown) ──────────────────────────── */}
      {candidateKeys.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="Pick at least one candidate"
          description="Add one or more models above and we'll rank them by quality, cost, reliability, and latency."
        />
      ) : (
        <RecommendationCard rec={recommendation} loading={recLoading} error={recError} />
      )}

      {/* ── Switch-only: side-by-side + cost projection ─────────── */}
      {mode === "switch" && candidateKeys[0] && candidateKeys[0] !== currentKey && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <CompareView comparison={comparison} loading={cmpLoading} error={cmpError} />
          <ProjectView
            projection={projection}
            loading={projLoading}
            error={projError}
            scaleFactor={scaleFactor}
            onScale={setScaleFactor}
          />
        </div>
      )}

      <div className="rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-4 py-3 text-xs text-[var(--text-muted)]">
        <Gauge className="mr-1 inline h-3.5 w-3.5" />
        Scoring is{" "}
        <span className="font-medium text-[var(--text-primary)]">quality 60% · cost 25% · reliability 10% · latency 5%</span>
        {" "}— biased toward &quot;what would still work well&quot; rather than &quot;what&apos;s cheapest&quot;. Prices honour your contract overrides.
      </div>
    
    </PageContent>
  );
}
