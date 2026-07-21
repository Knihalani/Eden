"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { fineTuneApi, type FineTuneLineage } from "@/lib/api";
import { Panel } from "@/components/ui/panel";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent, PageLoading } from "@/components/layout/page-content";
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
import { errorFromCaught } from "@/lib/safe-error-message";

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
      setError(errorFromCaught(e, "Failed to load fine-tune lineage"));
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
    return <PageLoading message="Loading lineage…" />;
  }

  if (error || !lineage) {
    return (
      <PageContent size="narrow" className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="min-h-11 px-0 w-fit">
          <Link href="/traces">
            <ArrowLeft className="w-4 h-4" />
            Back to traces
          </Link>
        </Button>
        <ErrorState
          title="Could not load lineage"
          message={error || `No lineage found for run ${runId}.`}
          size="md"
          action={
            <Button
              type="button"
              size="sm"
              onClick={() => void load()}
              disabled={loading}
              loading={loading}
            >
              Try again
            </Button>
          }
        />
      </PageContent>
    );
  }

  const statusInfo = STATUS_BADGE[lineage.run.status] ?? STATUS_BADGE.pending;
  const StatusIcon = statusInfo.icon;
  const evalResults = lineage.run.eval_results as
    | { mean_score?: number }
    | null;

  return (
    <PageContent size="default">
      <Button asChild variant="ghost" size="sm" className="min-h-11 px-0 w-fit">
        <Link href="/traces">
          <ArrowLeft className="w-4 h-4" />
          Back to traces
        </Link>
      </Button>

      <div data-wave10-lineage="signed" className="contents" />
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
      <Panel tone="flat" padding="md" className="space-y-3">
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
      </Panel>

      {/* Lineage graph */}
      <Panel tone="flat" padding="md" className="space-y-3">
        <h2 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Network className="w-4 h-4" />
          Dataset → Run → Production traces
        </h2>
        <LineageGraph lineage={lineage} />
      </Panel>

      {/* Backward + forward trace lists */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel tone="flat" padding="md" className="space-y-2">
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
        </Panel>
        <Panel tone="flat" padding="md" className="space-y-2">
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
        </Panel>
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