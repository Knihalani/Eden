"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft, Activity, Loader2, RefreshCw } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { useOrg } from "@/hooks/use-org";
import { learnApi } from "@/lib/api";
import { errorFromCaught } from "@/lib/safe-error-message";

interface DriftDimension {
  dimension: string;
  psi: number;
  flagged: boolean;
  delta_pct: number;
  summary: string;
}

export default function AgentDriftPage() {
  const params = useParams<{ id: string }>();
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

  const load = useCallback(async () => {
    if (!currentOrg || !agentId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await learnApi.getDrift(currentOrg.id, agentId);
      const report = res.data?.report;
      const dims = (report?.dimensions as DriftDimension[]) ?? [];
      setDimensions(dims);
      setSummary((report?.plain_english_summary as string) ?? null);
    } catch (e) {
      setError(errorFromCaught(e, "Failed to load drift report"));
    } finally {
      setLoading(false);
    }
  }, [currentOrg, agentId]);

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

  const flagged = dimensions.filter((d) => d.flagged);

  return (
    <PageContent>
      <PageHeader
        title="Behavioral drift"
        description={`PSI pinpoint report for ${agentId}`}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button size="sm" onClick={() => void recompute()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Recompute"}
            </Button>
          </div>
        }
      />
      <Link
        href={`/agents/${encodeURIComponent(agentId)}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to agent
      </Link>

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

      {summary ? (
        <Card className="mb-4 p-4">
          <div className="flex items-start gap-2">
            <Activity className="mt-0.5 h-5 w-5 text-[var(--accent)]" />
            <p className="text-sm text-[var(--text-secondary)]">{summary}</p>
          </div>
        </Card>
      ) : null}

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--text-muted)]" />
        </div>
      ) : dimensions.length === 0 ? (
        <EmptyState
          title="No drift data"
          description="Run compute to build a baseline comparison."
          action={
            <Button size="sm" onClick={() => void recompute()} disabled={busy}>
              Compute drift
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {dimensions.map((d) => (
            <Card
              key={d.dimension}
              className={`p-4 ${d.flagged ? "border-[var(--warning)]" : ""}`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{d.dimension}</span>
                <span
                  className={
                    d.flagged
                      ? "text-[var(--warning)]"
                      : "text-[var(--text-muted)]"
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
            </Card>
          ))}
          {flagged.length === 0 ? (
            <p className="text-center text-sm text-[var(--text-muted)]">
              No dimensions above PSI 0.2 threshold.
            </p>
          ) : null}
        </div>
      )}
    </PageContent>
  );
}
