"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  CalendarClock,
  Play,
  RefreshCw,
} from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { improveRunsApi, type ImprovementRun } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { useToast } from "@/components/ui/toast";
import { ImproveFeatureDisabledState } from "@/components/improve/feature-disabled-state";
import { errorFromCaught } from "@/lib/safe-error-message";
import { isImprovementAgentDisabled } from "@/lib/improve-feature";

function formatTs(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function statusClass(status: string): string {
  if (status === "completed") return "text-[var(--terminal)]";
  if (status === "failed") return "text-[var(--error)]";
  if (status === "running") return "text-[var(--accent)]";
  return "text-[var(--text-muted)]";
}

export default function ImprovementRunsPage() {
  const { currentOrg, authError } = useOrg();
  const toast = useToast();
  const [runs, setRuns] = useState<ImprovementRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [featureDisabled, setFeatureDisabled] = useState(false);
  const [triggerBusy, setTriggerBusy] = useState(false);

  const load = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError("");
    setFeatureDisabled(false);
    try {
      const data = await improveRunsApi.listRuns(currentOrg.id, "limit=50");
      setRuns(data.data.runs ?? []);
    } catch (err) {
      if (isImprovementAgentDisabled(err)) {
        setFeatureDisabled(true);
        setRuns([]);
        setError("");
      } else {
        setError(errorFromCaught(err, "Failed to load sweep history"));
      }
    } finally {
      setLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleTrigger() {
    if (!currentOrg) return;
    setTriggerBusy(true);
    try {
      await improveRunsApi.triggerRun(currentOrg.id);
      toast.success("Sweep triggered");
      await load();
    } catch (err) {
      if (isImprovementAgentDisabled(err)) {
        toast.error(errorFromCaught(err, "Feature disabled — ask an admin"));
        setFeatureDisabled(true);
      } else {
        toast.error(errorFromCaught(err, "Trigger failed"));
      }
    } finally {
      setTriggerBusy(false);
    }
  }

  if (!currentOrg && !authError) {
    return <NoOrgState feature="Sweep history" />;
  }
  if (!currentOrg) return null;

  return (
    <PageContent size="wide">
      <PageHeader
        title="Sweep history"
        subtitle="Improvement agent runs, watermarks, and plan counts per sweep"
        icon={CalendarClock}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading || featureDisabled}>
              <RefreshCw className={cn("h-4 w-4 mr-1", loading && "animate-spin")} />
              Refresh
            </Button>
            <Button size="sm" onClick={() => void handleTrigger()} disabled={triggerBusy || featureDisabled}>
              <Play className={cn("h-4 w-4 mr-1", triggerBusy && "animate-pulse")} />
              Run sweep now
            </Button>
          </div>
        }
      />

      {!featureDisabled ? (
      <p className="text-xs text-[var(--text-muted)] mb-4">
        Configure schedule and max plans per sweep in{" "}
        <Link href="/settings?tab=autonomous" className="text-[var(--accent)] hover:underline">
          Settings → Autonomous
        </Link>
        . View the inbox on{" "}
        <Link href="/improve/plans" className="text-[var(--accent)] hover:underline">
          Improvement plans
        </Link>
        .
      </p>
      ) : null}

      {featureDisabled ? (
        <ImproveFeatureDisabledState />
      ) : error ? (
        <ErrorState
          title="Could not load sweep history"
          message={error}
          className="mb-4"
          action={
            <Button
              onClick={() => void load()}
              variant="outline"
              size="sm"
              disabled={loading}
              loading={loading}
            >
              Try again
            </Button>
          }
        />
      ) : null}

      {featureDisabled || error ? null : loading && runs.length === 0 ? (
        <LoadingSkeleton variant="table" lines={5} />
      ) : !error && runs.length === 0 ? (
        <EmptyState
          title="No sweeps yet"
          description="Manual or scheduled improvement sweeps appear here with plan counts and LLM cost. Configure cadence in Settings, or trigger a sweep now once you have traces and issues."
          icon={CalendarClock}
          size="lg"
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                size="sm"
                className="min-h-11"
                onClick={() => void handleTrigger()}
                disabled={triggerBusy || featureDisabled}
              >
                <Play className={cn("h-4 w-4 mr-1", triggerBusy && "animate-pulse")} />
                Run sweep now
              </Button>
              <Button asChild variant="outline" className="min-h-11">
                <Link href="/settings?tab=autonomous">Configure schedule</Link>
              </Button>
              <Button asChild variant="ghost" className="min-h-11">
                <Link href="/improve/plans">View plans</Link>
              </Button>
            </div>
          }
        />
      ) : runs.length === 0 ? null : (
        <div className="overflow-x-auto rounded-lg border border-[var(--border-default)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--bg-secondary)] text-left text-xs text-[var(--text-muted)]">
              <tr>
                <th className="px-3 py-2 font-medium">Started</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Watermark</th>
                <th className="px-3 py-2 font-medium">Plans</th>
                <th className="px-3 py-2 font-medium">Skipped</th>
                <th className="px-3 py-2 font-medium">LLM cost</th>
                <th className="px-3 py-2 font-medium">Finished</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.id}
                  className="border-t border-[var(--border-default)] hover:bg-[var(--bg-secondary)]/40"
                >
                  <td className="px-3 py-2 whitespace-nowrap">{formatTs(run.started_at)}</td>
                  <td className={cn("px-3 py-2 capitalize font-medium", statusClass(run.status))}>
                    {run.status}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-[var(--text-muted)]">
                    {formatTs(run.last_run_at)}
                  </td>
                  <td className="px-3 py-2">{run.plans_created}</td>
                  <td className="px-3 py-2">{run.plans_skipped_dedup ?? 0}</td>
                  <td className="px-3 py-2">
                    {run.llm_cost_usd != null ? `$${run.llm_cost_usd.toFixed(4)}` : "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-[var(--text-muted)]">
                    {formatTs(run.finished_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageContent>
  );
}
