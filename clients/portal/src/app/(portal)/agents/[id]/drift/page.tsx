"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { ArrowLeft, Activity, Loader2, RefreshCw } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { DriftHistogram } from "@/components/portal-os/DriftHistogram";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useOrg } from "@/hooks/use-org";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { learnApi } from "@/lib/api";
import { driftHref, ledgerHref, tracesFilteredHref } from "@/lib/portal-cross-links";
import { errorFromCaught } from "@/lib/safe-error-message";
import { cn } from "@/lib/utils";

interface DriftDimension {
  dimension: string;
  psi: number;
  flagged: boolean;
  delta_pct: number;
  summary: string;
  baseline_histogram?: number[];
  current_histogram?: number[];
  sample_count?: number;
}

export default function AgentDriftPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--text-muted)]" />
        </div>
      }
    >
      <AgentDriftPageInner />
    </Suspense>
  );
}

function AgentDriftPageInner() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const focusDimension = searchParams.get("dimension");
  const agentId = useMemo(
    () => (params?.id ? decodeURIComponent(params.id) : ""),
    [params?.id],
  );
  const { currentOrg } = useOrg();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<DriftDimension[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focusedIdx, setFocusedIdx] = useState(0);

  const load = useCallback(async () => {
    if (!currentOrg || !agentId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await learnApi.getDrift(currentOrg.id, agentId);
      const report = res.data?.report;
      const dims = (report?.dimensions as DriftDimension[]) ?? [];
      setDimensions(dims);
      setSummary((report?.plain_english_summary as string) ?? null);
      if (focusDimension) {
        const idx = dims.findIndex((d) => d.dimension === focusDimension);
        if (idx >= 0) setFocusedIdx(idx);
      }
    } catch (e) {
      setError(errorFromCaught(e, "Failed to load drift report"));
    } finally {
      setLoading(false);
    }
  }, [currentOrg, agentId, focusDimension]);

  useEffect(() => {
    void load();
  }, [load]);

  const recompute = async () => {
    if (!currentOrg || !agentId) return;
    setBusy(true);
    try {
      await learnApi.computeDrift(currentOrg.id, agentId);
      await load();
    } catch (e) {
      setError(errorFromCaught(e, "Compute failed"));
    } finally {
      setBusy(false);
    }
  };

  useKeyboardShortcuts(
    {
      c: () => void recompute(),
      ...Object.fromEntries(
        [1, 2, 3, 4, 5, 6, 7].map((n) => [
          String(n),
          () => {
            const idx = n - 1;
            if (idx < dimensions.length) setFocusedIdx(idx);
          },
        ]),
      ),
    },
    dimensions.length > 0,
  );

  const flagged = dimensions.filter((d) => d.flagged);
  const focused = dimensions[focusedIdx];

  if (!currentOrg) {
    return <NoOrgState feature="Behavioral drift" icon={Activity} />;
  }

  return (
    <PageContent className="space-y-space-4">
      <PageHeader
        eyebrow="Agent"
        title="Behavioral drift"
        description={`24h vs 7d baseline · ${agentId}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild className="min-h-11">
              <Link href={ledgerHref(agentId)}>Ledger</Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11"
              onClick={() => void load()}
              disabled={loading}
              loading={loading}
              aria-label="Refresh drift report"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              className="min-h-11"
              onClick={() => void recompute()}
              disabled={busy}
              loading={busy}
            >
              Compute now
            </Button>
          </div>
        }
      />
      <Button asChild variant="ghost" size="sm" className="min-h-11 px-0 w-fit">
        <Link href={`/agents/${encodeURIComponent(agentId)}`}>
          <ArrowLeft className="h-4 w-4" />
          Back to agent
        </Link>
      </Button>

      {error ? (
        <ErrorState
          title="Could not load drift report"
          message={error}
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      ) : null}

      {!error && summary ? (
        <Card className="mb-4 p-4">
          <div className="flex items-start gap-2">
            <Activity className="mt-0.5 h-5 w-5 text-[var(--accent)]" />
            <p className="text-sm text-[var(--text-secondary)]">{summary}</p>
          </div>
        </Card>
      ) : null}

      {error ? null : loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--text-muted)]" />
        </div>
      ) : dimensions.length === 0 ? (
        <EmptyState
          title="No baseline yet"
          description="No baseline yet. Enough production traces are required before Eden can learn normal behavior."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="sm" onClick={() => void recompute()} disabled={busy}>
                Compute when data sufficient
              </Button>
              <Button size="sm" variant="outline" asChild>
                <Link href={tracesFilteredHref({ agent_id: agentId })}>Open Traces</Link>
              </Button>
            </div>
          }
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {dimensions.map((d, idx) => (
            <Card
              key={d.dimension}
              className={cn(
                "p-4",
                d.flagged && "border-[var(--warning)]",
                focusedIdx === idx && "ring-1 ring-[var(--accent)]",
              )}
              onClick={() => setFocusedIdx(idx)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter") setFocusedIdx(idx);
              }}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{d.dimension}</span>
                <span
                  className={
                    d.flagged ? "text-[var(--warning)]" : "text-[var(--text-muted)]"
                  }
                >
                  PSI {d.psi.toFixed(3)}
                </span>
              </div>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">{d.summary}</p>
              {d.delta_pct !== 0 ? (
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  Δ {d.delta_pct > 0 ? "+" : ""}
                  {d.delta_pct}%
                </p>
              ) : null}
              {d.baseline_histogram && d.current_histogram ? (
                <div className="mt-3">
                  <DriftHistogram
                    baseline={d.baseline_histogram}
                    current={d.current_histogram}
                  />
                </div>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                className="mt-3 w-full"
                asChild
              >
                <Link href={tracesFilteredHref({ agent_id: agentId, dimension: d.dimension })}>
                  Show example traces
                </Link>
              </Button>
            </Card>
          ))}
          {flagged.length === 0 ? (
            <p className="col-span-full text-center text-sm text-[var(--text-muted)]">
              No dimensions above PSI 0.2 threshold.
            </p>
          ) : null}
        </div>
      )}
      {!error && focused ? (
        <p className="mt-4 text-center text-xs text-[var(--text-muted)]">
          Focused: {focused.dimension} · Press 1–7 to switch · <kbd>c</kbd> recompute ·{" "}
          <Link href={driftHref(agentId, focused.dimension)} className="text-[var(--accent)] hover:underline">
            Share link
          </Link>
        </p>
      ) : null}
    </PageContent>
  );
}
