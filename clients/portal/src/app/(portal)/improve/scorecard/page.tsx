"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, RefreshCw, Trophy, XCircle } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage } from "@/components/portal-os";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Panel } from "@/components/ui/panel";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { useOrg } from "@/hooks/use-org";
import { learnApi } from "@/lib/api";
import { errorFromCaught } from "@/lib/safe-error-message";
import { cn } from "@/lib/utils";

const METRIC_LABELS: Record<string, { label: string; hint: string }> = {
  suite: { label: "Suite", hint: "Smoke or full evolution suite" },
  inject_tokens: { label: "Inject tokens", hint: "Packed ledger/artifact tokens" },
  inject_truncated: { label: "Truncated", hint: "Whether inject budget truncated" },
  hard_cap: { label: "Hard token cap", hint: "Inject budget hard limit" },
  soft_cap: { label: "Soft token cap", hint: "Inject budget soft limit" },
  hot_path_llm_invoked: { label: "Hot-path LLM", hint: "Must stay false on hot path" },
  hot_path_p95_ms: { label: "Hot-path p95", hint: "Must stay under 5ms" },
  trigger_dsl_ok: { label: "Trigger DSL", hint: "Nudge trigger evaluation" },
  elapsed_ms: { label: "Elapsed", hint: "Scorecard wall time" },
  lift_gate_pp: {
    label: "Lift gate",
    hint: "n/a (synthetic) — not org production quality lift",
  },
  cost_gate_usd: {
    label: "Cost gate",
    hint: "n/a (synthetic) — not org production cost delta",
  },
};

const SYNTHETIC_KEYS = new Set(["lift_gate_pp", "cost_gate_usd"]);

function formatMetric(key: string, value: unknown): string {
  if (SYNTHETIC_KEYS.has(key) && (value == null || value === 0 || value === 0.0)) {
    return "n/a (synthetic)";
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value == null) return "n/a (synthetic)";
  if (key.endsWith("_ms") && typeof value === "number") return `${value.toFixed(2)} ms`;
  if (key.endsWith("_usd") && typeof value === "number") return `$${value.toFixed(4)}`;
  if (key.endsWith("_pp") && typeof value === "number") return `${value.toFixed(1)} pp`;
  return String(value);
}

export default function ImproveScorecardPage() {
  const { currentOrg, authError } = useOrg();
  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState<Record<string, unknown> | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    try {
      const res = await learnApi.getScorecard(currentOrg.id, "smoke");
      setMetrics((res.data as { metrics?: Record<string, unknown> })?.metrics ?? null);
      setFailed(Boolean((res.data as { failed?: boolean })?.failed));
    } catch (e) {
      setError(errorFromCaught(e, "Failed to load scorecard"));
    } finally {
      setLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!currentOrg && !authError) return <NoOrgState feature="Evolution scorecard" />;
  if (!currentOrg) return null;

  const gateRows = metrics
    ? Object.entries(metrics).filter(([k]) => k !== "suite" && k !== "full_suite")
    : [];

  return (
    <div className="contents" data-wave8-improve-advanced="completed">
      <CoreResourcePage
        header={
          <PageHeader
            eyebrow="Advanced · Improve"
            title="Process gate microbench"
            description="Synthetic engineering gates only (inject budget, hot-path p95). Not organization production KPIs, quality lift, or cost."
            icon={Trophy}
            actions={
              <div className="flex flex-wrap items-center gap-space-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-11"
                  onClick={() => void load()}
                  disabled={loading}
                >
                  <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
                  Refresh
                </Button>
                <Button variant="ghost" size="sm" className="min-h-11" asChild>
                  <Link href="/improve">Back to Improve</Link>
                </Button>
              </div>
            }
          />
        }
        table={
          <>
            {loading ? (
              <LoadingSkeleton variant="table" lines={5} />
            ) : error ? (
              <ErrorState
                message={error}
                action={
                  <Button variant="outline" size="sm" onClick={() => void load()}>
                    Try again
                  </Button>
                }
              />
            ) : !metrics ? (
              <EmptyState
                icon={Trophy}
                size="lg"
                title="No scorecard metrics"
                description="Run the evolution suite to populate inject and hot-path process gates. Results are synthetic — not org KPIs."
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    onClick={() => void load()}
                  >
                    <RefreshCw className="h-4 w-4" />
                    Retry scorecard
                  </Button>
                }
              />
            ) : (
              <div className="space-y-space-4" data-testid="scorecard-gates">
                <Panel
                  tone="flat"
                  padding="md"
                  className="border-l-2 border-l-[var(--warning)]"
                  data-testid="scorecard-synthetic-banner"
                >
                  <p className="text-sm font-semibold text-[var(--warning)]">
                    Synthetic process gate — not org KPIs
                  </p>
                  <p className="mt-space-1 text-xs text-[var(--text-muted)]">
                    Local microbench for inject budget and hot-path latency — not org
                    production quality, lift, or cost.
                  </p>
                </Panel>

                <div
                  className={cn(
                    "flex items-center gap-space-3 border-b border-[var(--border-subtle)] py-space-3",
                    failed ? "text-[var(--error)]" : "text-[var(--terminal)]",
                  )}
                >
                  {failed ? (
                    <XCircle className="h-5 w-5 shrink-0" />
                  ) : (
                    <CheckCircle2 className="h-5 w-5 shrink-0" />
                  )}
                  <div>
                    <p className="text-sm font-semibold text-[var(--text-primary)]">
                      {failed ? "Process gates failed" : "All process gates passed"}
                    </p>
                    <p className="text-xs text-[var(--text-muted)]">
                      Suite: {String(metrics.suite ?? "smoke")} · synthetic microbench
                    </p>
                  </div>
                </div>

                <div
                  className="overflow-x-auto border-y border-[var(--border-subtle)]"
                  data-testid="scorecard-gates-table"
                >
                  <table className="w-full text-sm">
                    <thead className="bg-[var(--bg-tertiary)] text-left text-xs text-[var(--text-muted)]">
                      <tr>
                        <th className="px-space-3 py-space-1.5 font-medium">Gate</th>
                        <th className="px-space-3 py-space-1.5 font-medium">Kind</th>
                        <th className="px-space-3 py-space-1.5 font-medium">Value</th>
                        <th className="px-space-3 py-space-1.5 font-medium">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gateRows.map(([k, v]) => {
                        const meta = METRIC_LABELS[k] ?? {
                          label: k.replace(/_/g, " "),
                          hint: "Process-gate metric (synthetic)",
                        };
                        const synthetic = SYNTHETIC_KEYS.has(k);
                        return (
                          <tr
                            key={k}
                            className="border-t border-[var(--border-subtle)] hover:bg-[var(--bg-secondary)]/40"
                          >
                            <td className="px-space-3 py-space-1.5 font-medium text-[var(--text-primary)]">
                              {meta.label}
                            </td>
                            <td className="px-space-3 py-space-1.5 text-xs uppercase tracking-wide">
                              {synthetic ? (
                                <span className="text-[var(--warning)]">synthetic</span>
                              ) : (
                                <span className="text-[var(--text-muted)]">process gate</span>
                              )}
                            </td>
                            <td className="px-space-3 py-space-1.5 tabular-nums font-semibold">
                              {formatMetric(k, v)}
                            </td>
                            <td className="px-space-3 py-space-1.5 text-xs text-[var(--text-muted)]">
                              {meta.hint}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        }
      />
    </div>
  );
}
