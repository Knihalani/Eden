"use client";

import { useState } from "react";
import Link from "next/link";
import {
  CalendarClock,
  Play,
  RefreshCw,
} from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { improveRunsApi, type ImprovementRun } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
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
import { VirtualizedList } from "@/components/portal-os";
import { STICKY_FIRST_TD, STICKY_FIRST_TH } from "@/components/ui/table-sticky";
import { errorFromCaught } from "@/lib/safe-error-message";
import { isImprovementAgentDisabled } from "@/lib/improve-feature";

const RUN_MOBILE_ROW = 96;
const RUN_DESKTOP_ROW = 44;

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

function RunMobileCard({ run }: { run: ImprovementRun }) {
  return (
    <div className="rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-space-3 py-space-2 space-y-space-1">
      <p className="text-sm font-medium text-[var(--text-primary)]">
        {formatTs(run.started_at)}
      </p>
      <p className={cn("text-xs font-medium capitalize", statusClass(run.status))}>
        {run.status}
      </p>
      <p className="text-xs text-[var(--text-muted)]">
        Plans {run.plans_created}
        {" · "}
        Skipped {run.plans_skipped_dedup ?? 0}
        {" · "}
        {run.llm_cost_usd != null ? `$${run.llm_cost_usd.toFixed(4)}` : "No LLM cost"}
        {" · "}
        Finished {formatTs(run.finished_at)}
      </p>
    </div>
  );
}

function RunDesktopRow({ run }: { run: ImprovementRun }) {
  return (
    <div
      role="row"
      className="grid grid-cols-[minmax(9rem,1.4fr)_minmax(5rem,0.7fr)_minmax(8rem,1fr)_minmax(4rem,0.5fr)_minmax(4rem,0.5fr)_minmax(5rem,0.6fr)_minmax(8rem,1fr)] gap-space-2 border-t border-[var(--border-subtle)] px-space-2 py-space-1.5 text-sm hover:bg-[var(--bg-secondary)]/40"
    >
      <span role="cell" className={cn(STICKY_FIRST_TD, "whitespace-nowrap truncate py-space-1.5")}>
        {formatTs(run.started_at)}
      </span>
      <span role="cell" className={cn("capitalize font-medium truncate", statusClass(run.status))}>
        {run.status}
      </span>
      <span role="cell" className="whitespace-nowrap truncate text-xs text-[var(--text-muted)]">
        {formatTs(run.last_run_at)}
      </span>
      <span role="cell" className="tabular-nums">
        {run.plans_created}
      </span>
      <span role="cell" className="tabular-nums">
        {run.plans_skipped_dedup ?? 0}
      </span>
      <span role="cell" className="tabular-nums">
        {run.llm_cost_usd != null ? `$${run.llm_cost_usd.toFixed(4)}` : "—"}
      </span>
      <span role="cell" className="whitespace-nowrap truncate text-xs text-[var(--text-muted)]">
        {formatTs(run.finished_at)}
      </span>
    </div>
  );
}

export default function ImprovementRunsPage() {
  const { currentOrg, authError } = useOrg();
  const toast = useToast();
  const orgId = currentOrg?.id ?? null;
  const [triggerBusy, setTriggerBusy] = useState(false);

  const runsQuery = useOrgQuery(
    queryKeys.improve.runs(orgId),
    orgId,
    async () => {
      const data = await improveRunsApi.listRuns(orgId!, "limit=50");
      return data.data.runs ?? [];
    },
  );

  const triggerMutation = useOrgMutation(
    () => improveRunsApi.triggerRun(orgId!),
    { invalidateKeys: [queryKeys.improve.runs(orgId)] },
  );

  const runs: ImprovementRun[] = runsQuery.data ?? [];
  const loading = runsQuery.isLoading;
  const featureDisabled =
    !!runsQuery.error && isImprovementAgentDisabled(runsQuery.error);
  const error =
    runsQuery.error && !featureDisabled
      ? errorFromCaught(runsQuery.error, "Failed to load sweep history")
      : "";

  async function handleTrigger() {
    if (!currentOrg) return;
    setTriggerBusy(true);
    try {
      await triggerMutation.mutateAsync();
      toast.success("Sweep triggered");
      await runsQuery.refetch();
    } catch (err) {
      if (isImprovementAgentDisabled(err)) {
        toast.error(errorFromCaught(err, "Feature disabled — ask an admin"));
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
    <PageContent size="wide" data-wave9-improve-crossloop="history">
      <PageHeader
        title="Sweep history"
        subtitle="Improvement agent runs, watermarks, and plan counts per sweep"
        icon={CalendarClock}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              className="min-h-11"
              onClick={() => void runsQuery.refetch()}
              disabled={loading || featureDisabled}
            >
              <RefreshCw className={cn("h-4 w-4 mr-1", loading && "animate-spin")} />
              Refresh
            </Button>
            <Button
              size="sm"
              className="min-h-11"
              onClick={() => void handleTrigger()}
              disabled={triggerBusy || featureDisabled}
              data-testid="improve-runs-trigger"
            >
              <Play className={cn("h-4 w-4 mr-1", triggerBusy && "animate-pulse")} />
              Run sweep now
            </Button>
          </div>
        }
      />

      {!featureDisabled ? (
      <p className="text-xs text-[var(--text-muted)] mb-space-3">
        Schedule in{" "}
        <Link href="/settings?tab=autonomous" className="text-[var(--accent)] hover:underline">
          Settings → Autonomous
        </Link>
        . Plans in the{" "}
        <Link href="/improve?tab=plans" className="text-[var(--accent)] hover:underline">
          Plans
        </Link>{" "}
        tab.
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
              onClick={() => void runsQuery.refetch()}
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
          description="No sweeps recorded yet. Manual or scheduled improvement sweeps appear here with plan counts and LLM cost. Configure cadence in Settings → Autonomous once you have traces and issues."
          icon={CalendarClock}
          size="lg"
          action={
            <Button
              size="sm"
              className="min-h-11"
              onClick={() => void handleTrigger()}
              disabled={triggerBusy || featureDisabled}
              data-testid="improve-runs-empty-trigger"
            >
              <Play className={cn("h-4 w-4 mr-1", triggerBusy && "animate-pulse")} />
              Run sweep now
            </Button>
          }
        />
      ) : runs.length === 0 ? null : (
        <>
          <div
            className="lg:hidden"
            data-testid="improve-runs-mobile-cards"
            data-wave11-mobile="cards"
          >
            <VirtualizedList
              items={runs}
              rowKey={(run) => run.id}
              rowHeight={RUN_MOBILE_ROW}
              className="flex flex-col gap-space-3 max-h-[min(36rem,70vh)]"
            >
              {(run) => <RunMobileCard run={run} />}
            </VirtualizedList>
          </div>
          <div
            className="hidden overflow-x-auto lg:block"
            data-testid="improve-runs-table"
            role="table"
            aria-label="Sweep history"
          >
            <div
              role="row"
              className="grid grid-cols-[minmax(9rem,1.4fr)_minmax(5rem,0.7fr)_minmax(8rem,1fr)_minmax(4rem,0.5fr)_minmax(4rem,0.5fr)_minmax(5rem,0.6fr)_minmax(8rem,1fr)] gap-space-2 bg-[var(--bg-tertiary)] px-space-2 py-space-1.5 text-left text-xs font-medium text-[var(--text-muted)]"
            >
              <span role="columnheader" className={STICKY_FIRST_TH}>
                Started
              </span>
              <span role="columnheader">Status</span>
              <span role="columnheader">Watermark</span>
              <span role="columnheader">Plans</span>
              <span role="columnheader">Skipped</span>
              <span role="columnheader">LLM cost</span>
              <span role="columnheader">Finished</span>
            </div>
            <VirtualizedList
              items={runs}
              rowKey={(run) => run.id}
              rowHeight={RUN_DESKTOP_ROW}
              className="max-h-[min(36rem,70vh)]"
            >
              {(run) => <RunDesktopRow run={run} />}
            </VirtualizedList>
          </div>
        </>
      )}
    </PageContent>
  );
}
