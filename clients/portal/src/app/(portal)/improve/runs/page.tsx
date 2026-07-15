"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  CalendarClock,
  Play,
  RefreshCw,
} from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { improveRunsApi, type ImprovementRun } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { useToast } from "@/components/ui/toast";
import { errorFromCaught } from "@/lib/safe-error-message";

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
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [runs, setRuns] = useState<ImprovementRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [triggerBusy, setTriggerBusy] = useState(false);

  const load = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError("");
    try {
      const data = await improveRunsApi.listRuns(currentOrg.id, "limit=50");
      setRuns(data.data.runs ?? []);
    } catch (err) {
      setError(errorFromCaught(err, "Failed to load sweep history"));
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
      toast.error(errorFromCaught(err, "Trigger failed"));
    } finally {
      setTriggerBusy(false);
    }
  }

  if (!currentOrg) {
    return <NoOrgState feature="Sweep history" />;
  }

  return (
    <PageContent size="wide">
      <PageHeader
        title="Sweep history"
        subtitle="Improvement agent runs, watermarks, and plan counts per sweep"
        icon={CalendarClock}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={cn("h-4 w-4 mr-1", loading && "animate-spin")} />
              Refresh
            </Button>
            <Button size="sm" onClick={() => void handleTrigger()} disabled={triggerBusy}>
              <Play className={cn("h-4 w-4 mr-1", triggerBusy && "animate-pulse")} />
              Run sweep now
            </Button>
          </div>
        }
      />

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

      {error && (
        <Card className="border-[var(--error)]/20 bg-[var(--error)]/5 mb-4">
          <div role="alert" className="p-3 text-sm text-[var(--error)] flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        </Card>
      )}

      {loading && runs.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">Loading runs…</p>
      ) : runs.length === 0 ? (
        <EmptyState
          title="No sweeps yet"
          description="Manual or scheduled improvement sweeps appear here with plan counts and LLM cost."
          icon={CalendarClock}
        />
      ) : (
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
