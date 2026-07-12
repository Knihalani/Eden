"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { agentsApi, type SimRun } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent, PageLoading } from "@/components/layout/page-content";
import { ArrowLeft, Beaker, CheckCircle2, Clock, Loader2, XCircle, AlertCircle, Hash, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { errorFromCaught } from "@/lib/safe-error-message";

const STATUS_BADGE: Record<string, { bg: string; icon: typeof CheckCircle2 }> = {
  pending: { bg: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]", icon: Clock },
  running: { bg: "bg-[var(--accent-faint)] text-[var(--accent)]", icon: Loader2 },
  passed: { bg: "bg-[var(--terminal-faint)] text-[var(--terminal)]", icon: CheckCircle2 },
  failed: { bg: "bg-[var(--error-bg)] text-[var(--error)]", icon: XCircle },
  error: { bg: "bg-[var(--error-dim)] text-[var(--error)]", icon: AlertCircle } };

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

function formatTime(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function SimRunDetailPage() {
  const params = useParams<{ id: string; run_id: string }>();
  const agentId = decodeURIComponent(params.id);
  const runId = decodeURIComponent(params.run_id);
  const { currentOrg } = useOrg();
  const [run, setRun] = useState<SimRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    try {
      const data = await agentsApi.getSimRun(currentOrg.id, agentId, runId);
      setRun(data);
    } catch (e) {
      setError(errorFromCaught(e, "Failed to load sim run"));
    } finally {
      setLoading(false);
    }
  }, [currentOrg, agentId, runId]);

  useEffect(() => {
     
    if (currentOrg) load();
  }, [currentOrg, load]);

  if (!currentOrg) {
    return (
      <NoOrgState
        icon={Beaker}
        feature="Sim run"
        description="Inspect a sim run for this agent."
      />
    );
  }

  if (loading && !run) {
    return <PageLoading message="Loading sim run…" />;
  }

  if (error || !run) {
    return (
      <PageContent size="narrow" className="space-y-4">
        <Link
          href={`/agents/${encodeURIComponent(agentId)}/sim-runs`}
          className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
        >
          <ArrowLeft className="w-3 h-3" />
          Back to sim runs
        </Link>
        <ErrorState
          title="Could not load sim run"
          message={error || "Run not found."}
          size="md"
          action={
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex items-center gap-2 px-3 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-xs font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              Try again
            </button>
          }
        />
      </PageContent>
    );
  }

  const StatusIcon = STATUS_BADGE[run.status]?.icon ?? Clock;
  const statusClass = STATUS_BADGE[run.status]?.bg ?? "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]";

  return (
    <PageContent size="default">
      <Link
        href={`/agents/${encodeURIComponent(agentId)}/sim-runs`}
        className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
      >
        <ArrowLeft className="w-3 h-3" />
        Back to sim runs
      </Link>

      <PageHeader
        eyebrow="Sim run"
        title={run.id}
        icon={StatusIcon}
        subtitle={
          <span className="flex items-center gap-2">
            <span
              className={cn(
                "text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded",
                statusClass,
              )}
            >
              {run.status}
            </span>
            <span>·</span>
            <span className="font-mono text-xs">{agentId}</span>
          </span>
        }
      />

      <Card className="p-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field icon={Hash} label="Run ID" value={run.id.slice(0, 12) + "…"} mono />
          <Field icon={Play} label="Runner" value={run.runner_kind ?? "—"} />
          <Field icon={Clock} label="Started" value={formatTime(run.started_at)} />
          <Field icon={Clock} label="Duration" value={formatDuration(run.duration_ms)} />
        </div>

        {run.error && (
          <div className="mt-4 p-3 rounded-lg border border-[var(--error)]/20 bg-[var(--error-bg)] flex items-start gap-2 text-sm text-[var(--error)]">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <pre className="text-xs whitespace-pre-wrap font-mono">{run.error}</pre>
          </div>
        )}
      </Card>

      {run.results && Object.keys(run.results).length > 0 && (
        <Card className="p-6">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
            Results
          </h2>
          <pre className="text-xs bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto max-h-[60vh] font-mono text-[var(--text-secondary)]">
            {JSON.stringify(run.results, null, 2)}
          </pre>
        </Card>
      )}
    
    </PageContent>
  );
}

function Field({
  icon: Icon,
  label,
  value,
  mono }: {
  icon: typeof Hash;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)]/40 p-3">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)] font-medium">
        <Icon className="w-3 h-3" />
        {label}
      </div>
      <p
        className={cn(
          "text-sm mt-1 truncate",
          mono ? "font-mono text-[var(--text-primary)]" : "text-[var(--text-primary)]",
        )}
        title={value}
      >
        {value}
      </p>
    </div>
  );
}
