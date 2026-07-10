"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { fineTuneApi, type FineTuneLineage } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import {
  ArrowLeft,
  Network,
  CheckCircle2,
  Clock,
  Loader2,
  XCircle,
  
  Database,
  ArrowRight } from "lucide-react";
import { LineageGraph } from "./_components/LineageGraph";

const STATUS_BADGE: Record<
  string,
  { bg: string; icon: typeof CheckCircle2 }
> = {
  pending: { bg: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]", icon: Clock },
  running: { bg: "bg-[var(--accent-faint)] text-[var(--accent)]", icon: Loader2 },
  succeeded: { bg: "bg-[var(--terminal-faint)] text-[var(--terminal)]", icon: CheckCircle2 },
  failed: { bg: "bg-[var(--error-bg)] text-[var(--error)]", icon: XCircle } };

function formatTime(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function FineTuneLineagePage() {
  const params = useParams<{ run_id: string }>();
  const runId = decodeURIComponent(params.run_id);
  const { currentOrg } = useOrg();
  const [lineage, setLineage] = useState<FineTuneLineage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fineTuneApi.getLineage(runId);
      setLineage(data.data ?? null);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to load fine-tune lineage"
      );
    } finally {
      setLoading(false);
    }
  }, [currentOrg, runId]);

  useEffect(() => {
     
    if (currentOrg) load();
  }, [currentOrg, load]);

  if (!currentOrg) {
    return (
      <NoOrgState
        icon={Network}
        feature="Fine-tune lineage"
        description="Inspect the dataset + traces that built a fine-tune run, plus the traces that used the fine-tuned model in production."
      />
    );
  }

  if (loading && !lineage) {
    return (
      <div className="p-8 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
      </div>
    );
  }

  if (error || !lineage) {
    return (
      <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto space-y-4">
        <Link
          href="/observability"
          className="inline-flex items-center gap-2 text-sm text-[var(--text-secondary)] hover:text-[var(--accent)]"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to observability
        </Link>
        <ErrorState
          title="Could not load lineage"
          message={error || `No lineage found for run ${runId}.`}
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
      </div>
    );
  }

  const statusInfo = STATUS_BADGE[lineage.run.status] ?? STATUS_BADGE.pending;
  const StatusIcon = statusInfo.icon;
  const evalResults = lineage.run.eval_results as
    | { mean_score?: number }
    | null;

  return (
    <PageContent size="default">
      <Link
        href="/observability"
        className="inline-flex items-center gap-2 text-sm text-[var(--text-secondary)] hover:text-[var(--accent)]"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to observability
      </Link>

      <PageHeader
        eyebrow="Fine-tune"
        title="Lineage"
        icon={Network}
        subtitle={
          <>
            Run <code className="text-xs">{lineage.run.id}</code> ·
            Provider <span className="font-mono">{lineage.run.provider}</span>
          </>
        }
      />

      {/* Run summary */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-3">
          <StatusIcon className="w-5 h-5" />
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusInfo.bg}`}
          >
            {lineage.run.status}
          </span>
          <span className="text-sm text-[var(--text-secondary)]">
            {lineage.run.base_model} → {lineage.run.fine_tuned_model}
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
          <Field label="Created" value={formatTime(lineage.run.created_at)} />
          <Field
            label="Completed"
            value={formatTime(lineage.run.completed_at)}
          />
          <Field
            label="Mean eval score"
            value={
              evalResults?.mean_score != null
                ? evalResults.mean_score.toFixed(3)
                : "—"
            }
          />
          <Field
            label="Provider fine-tune id"
            value={lineage.run.provider_fine_tune_id ?? "—"}
          />
        </div>
      </Card>

      {/* Lineage graph */}
      <Card className="p-4 space-y-3">
        <h2 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Network className="w-4 h-4" />
          Dataset → Run → Production traces
        </h2>
        <LineageGraph lineage={lineage} />
      </Card>

      {/* Backward + forward trace lists */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-4 space-y-2">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Database className="w-4 h-4" />
            Backward ({lineage.backward.trace_ids.length} traces)
          </h3>
          <p className="text-xs text-[var(--text-secondary)]">
            The traces that built dataset{" "}
            <code className="font-mono">{lineage.backward.dataset_id.slice(0, 8)}…</code>.
          </p>
          <ul className="space-y-1 max-h-64 overflow-y-auto">
            {lineage.backward.trace_ids.slice(0, 20).map((tid) => (
              <li
                key={tid}
                className="text-xs font-mono px-2 py-1 bg-[var(--bg-tertiary)] rounded"
              >
                {tid}
              </li>
            ))}
            {lineage.backward.trace_ids.length > 20 && (
              <li className="text-xs text-[var(--text-secondary)] italic">
                … and {lineage.backward.trace_ids.length - 20} more
              </li>
            )}
          </ul>
        </Card>
        <Card className="p-4 space-y-2">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <ArrowRight className="w-4 h-4" />
            Forward ({lineage.forward.trace_ids.length} traces)
          </h3>
          <p className="text-xs text-[var(--text-secondary)]">
            Production traces that used{" "}
            <code className="font-mono">{lineage.forward.fine_tuned_model}</code>.
          </p>
          <ul className="space-y-1 max-h-64 overflow-y-auto">
            {lineage.forward.trace_ids.slice(0, 20).map((tid) => (
              <li
                key={tid}
                className="text-xs font-mono px-2 py-1 bg-[var(--bg-tertiary)] rounded"
              >
                {tid}
              </li>
            ))}
            {lineage.forward.trace_ids.length > 20 && (
              <li className="text-xs text-[var(--text-secondary)] italic">
                … and {lineage.forward.trace_ids.length - 20} more
              </li>
            )}
          </ul>
        </Card>
      </div>
    
    </PageContent>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">
        {label}
      </div>
      <div className="text-sm font-mono text-[var(--text-primary)] truncate">
        {value}
      </div>
    </div>
  );
}