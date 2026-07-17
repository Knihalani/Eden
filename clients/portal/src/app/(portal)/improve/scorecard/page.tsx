"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Trophy, XCircle, CheckCircle2 } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { CrossLinkBar, CoreResourcePage } from "@/components/portal-os";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
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
  lift_gate_pp: { label: "Lift gate", hint: "Quality lift percentage points" },
  cost_gate_usd: { label: "Cost gate", hint: "Max allowed cost delta USD" },
};

function formatMetric(key: string, value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (key.endsWith("_ms") && typeof value === "number") return `${value.toFixed(2)} ms`;
  if (key.endsWith("_usd") && typeof value === "number") return `$${value.toFixed(4)}`;
  if (key.endsWith("_pp") && typeof value === "number") return `${value.toFixed(1)} pp`;
  return String(value);
}

export default function ImproveScorecardPage() {
  const { currentOrg } = useOrg();
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

  if (!currentOrg) return <NoOrgState feature="Evolution scorecard" />;

  return (
    <CoreResourcePage
      header={
        <PageHeader
          title="Evolution scorecard"
          description="Inject budget, hot-path p95, and lift gates — human-readable evolution gates."
          icon={Trophy}
          actions={
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
              Refresh
            </Button>
          }
        />
      }
      toolbar={
        <CrossLinkBar
          className="mb-4"
          links={[
            { label: "Improve", href: "/improve" },
            { label: "Change impact", href: "/improve/change-impact" },
            { label: "Onboarding loop", href: "/onboarding/improvement-loop" },
          ]}
        />
      }
      table={
        <>
          {error ? (
            <ErrorState
              message={error}
              action={
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  Try again
                </Button>
              }
            />
          ) : null}

          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-[var(--text-muted)]" />
            </div>
          ) : !metrics ? (
            <EmptyState
              title="No scorecard metrics"
              description="Run the evolution suite to populate inject and hot-path gates."
            />
          ) : (
            <div className="space-y-4">
              <Card
                className={cn(
                  "flex items-center gap-3 p-4",
                  failed
                    ? "border-[var(--error)]/40 bg-[var(--error)]/5"
                    : "border-[var(--terminal)]/40 bg-[var(--terminal)]/5",
                )}
              >
                {failed ? (
                  <XCircle className="h-6 w-6 text-[var(--error)]" />
                ) : (
                  <CheckCircle2 className="h-6 w-6 text-[var(--terminal)]" />
                )}
                <div>
                  <p className="text-sm font-semibold">
                    {failed ? "Gates failed" : "All gates passed"}
                  </p>
                  <p className="text-xs text-[var(--text-muted)]">
                    Suite: {String(metrics.suite ?? "smoke")}
                  </p>
                </div>
              </Card>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(metrics)
                  .filter(([k]) => k !== "suite" && k !== "full_suite")
                  .map(([k, v]) => {
                    const meta = METRIC_LABELS[k] ?? {
                      label: k.replace(/_/g, " "),
                      hint: "",
                    };
                    return (
                      <Card key={k} className="p-4">
                        <p className="text-xs text-[var(--text-muted)]">{meta.label}</p>
                        <p className="mt-1 text-lg font-semibold tabular-nums">
                          {formatMetric(k, v)}
                        </p>
                        {meta.hint ? (
                          <p className="mt-1 text-[11px] text-[var(--text-muted)]">{meta.hint}</p>
                        ) : null}
                      </Card>
                    );
                  })}
              </div>
            </div>
          )}
        </>
      }
    />
  );
}
