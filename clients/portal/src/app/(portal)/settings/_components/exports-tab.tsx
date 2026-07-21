"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import {
  Plus,
  Cloud,
  CheckCircle2,
  XCircle,
  Calendar,
  FileArchive,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DataTable } from "@/components/ui/data-table";
import { Card } from "@/components/ui/card";
import { IntegrationStatusBanners } from "@/components/integration-status-banners";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  DestinationForm,
  LegacyExportFallback,
  ScheduleForm,
} from "./exports-forms";
import { buildExportDestColumns, buildExportSchedColumns } from "./exports-columns";

interface ExportsTabProps {
  orgId: string;
  canManage: boolean;
}

export function ExportsTab({ orgId, canManage }: ExportsTabProps) {
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const destQuery = useOrgQuery(queryKeys.exports.destinations(orgId), orgId, () =>
    api.listExportDestinations(orgId),
  );
  const schedQuery = useOrgQuery(queryKeys.exports.schedules(orgId), orgId, () =>
    api.listExportSchedules(orgId),
  );
  const destinations = destQuery.data ?? [];
  const schedules = schedQuery.data ?? [];
  const loadingDest = destQuery.isLoading;
  const loadingSched = schedQuery.isLoading;
  const error = destQuery.error?.message ?? schedQuery.error?.message ?? null;
  const [running, setRunning] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<{
    id: string;
    status: "ok" | "err";
    message: string;
  } | null>(null);
  const [showDestForm, setShowDestForm] = useState(false);
  const [showSchedForm, setShowSchedForm] = useState(false);

  async function loadAll() {
    await Promise.all([destQuery.refetch(), schedQuery.refetch()]);
  }

  async function handleRunNow(scheduleId: string) {
    if (!orgId) return;
    setRunning(scheduleId);
    setRunResult(null);
    try {
      const result = await api.runExportNow(orgId, scheduleId);
      setRunResult({
        id: scheduleId,
        status: "ok",
        message: `Wrote ${result.bytes_written} bytes to ${result.destination}`,
      });
      await loadAll();
    } catch (err: unknown) {
      setRunResult({
        id: scheduleId,
        status: "err",
        message: err instanceof Error ? err.message : "Export failed",
      });
    } finally {
      setRunning(null);
    }
  }

  if (!orgId) {
    return (
      <div className="text-center py-12 text-[var(--text-secondary)]" data-ws7-exports>
        Select a workspace to manage exports
      </div>
    );
  }

  if (!canManage) {
    return (
      <div
        className="p-6 bg-[var(--error-bg)] rounded-lg border border-[var(--error)]/20"
        data-ws7-exports
      >
        <p className="text-sm text-[var(--error)]">
          You do not have permission to manage exports. Contact your workspace admin.
        </p>
      </div>
    );
  }

  const destColumns = buildExportDestColumns({
    orgId,
    onDelete: async (d) => {
      const ok = await confirm({
        title: `Delete destination "${d.name}"?`,
        confirmLabel: "Delete",
        variant: "destructive",
      });
      if (!ok) return;
      try {
        await api.deleteExportDestination(orgId, d.destination_id);
        await loadAll();
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : "Failed to delete");
      }
    },
  });

  const schedColumns = buildExportSchedColumns({
    destinations,
    running,
    onRun: (id) => void handleRunNow(id),
    onDelete: async (s) => {
      const ok = await confirm({
        title: "Delete this schedule?",
        confirmLabel: "Delete",
        variant: "destructive",
      });
      if (!ok) return;
      try {
        await api.deleteExportSchedule(orgId, s.schedule_id);
        await loadAll();
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : "Failed to delete");
      }
    },
  });

  return (
    <div className="space-y-space-6" data-ws7-exports>
      <IntegrationStatusBanners integration="exports" orgId={orgId} />

      <div>
        <h2 className="text-sm font-semibold flex items-center gap-space-2 text-[var(--text-primary)]">
          <FileArchive className="w-4 h-4 text-[var(--text-muted)]" />
          Destinations & jobs
        </h2>
        <p className="text-sm text-[var(--text-secondary)] mt-space-1">
          Stream workspace data into S3 or GCS. One-shot or recurring; CSV, Parquet, or JSONL.
          Exports respect your retention policy.
        </p>
      </div>

      {error && (
        <ErrorState
          title="Could not load exports"
          message={error}
          action={
            <Button onClick={() => void loadAll()} variant="outline" size="default">
              <RefreshCw className="w-4 h-4" />
              Try again
            </Button>
          }
        />
      )}

      {!error && runResult && (
        <div
          className={cn(
            "p-3 rounded-lg border text-sm flex items-center gap-2",
            runResult.status === "ok"
              ? "bg-[var(--success-bg)] border-[var(--success)]/30 text-[var(--success)]"
              : "bg-[var(--error-bg)] border-[var(--error)]/30 text-[var(--error)]",
          )}
        >
          {runResult.status === "ok" ? (
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          ) : (
            <XCircle className="w-4 h-4 flex-shrink-0" />
          )}
          {runResult.message}
        </div>
      )}

      {!error && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Cloud className="w-4 h-4 text-[var(--text-muted)]" />
              Destinations
            </h3>
            <Button
              type="button"
              variant="default"
              className="min-h-11"
              onClick={() => setShowDestForm((v) => !v)}
            >
              <Plus className="w-4 h-4" />
              {showDestForm ? "Cancel" : "Add destination"}
            </Button>
          </div>
          {showDestForm && (
            <DestinationForm
              orgId={orgId}
              onSaved={async () => {
                setShowDestForm(false);
                await loadAll();
              }}
              onCancel={() => setShowDestForm(false)}
            />
          )}
          {loadingDest ? (
            <div className="space-y-2 py-2" aria-busy="true" aria-live="polite">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : destinations.length === 0 ? (
            <EmptyState
              icon={Cloud}
              title="No destinations yet"
              description="Add an S3 or GCS bucket as an export destination."
              size="sm"
            />
          ) : (
            <Card padding="lg" className="overflow-hidden">
              <DataTable
                columns={destColumns}
                rows={destinations}
                rowKey={(d) => d.destination_id}
                defaultSort={{ key: "name", direction: "asc" }}
                emptyTitle="No destinations yet"
                emptyDescription="Add an S3 or GCS bucket as an export destination."
                emptyIcon={Cloud}
                pageSize={25}
              />
            </Card>
          )}
        </section>
      )}

      {!error && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Calendar className="w-4 h-4 text-[var(--text-muted)]" />
              Schedules
            </h3>
            <Button
              type="button"
              variant="default"
              className="min-h-11"
              onClick={() => setShowSchedForm((v) => !v)}
              disabled={destinations.length === 0}
              title={destinations.length === 0 ? "Add a destination first" : ""}
            >
              <Plus className="w-4 h-4" />
              {showSchedForm ? "Cancel" : "New schedule"}
            </Button>
          </div>
          {showSchedForm && (
            <ScheduleForm
              orgId={orgId}
              destinations={destinations}
              onSaved={async () => {
                setShowSchedForm(false);
                await loadAll();
              }}
              onCancel={() => setShowSchedForm(false)}
            />
          )}
          {loadingSched ? (
            <div className="space-y-2 py-2" aria-busy="true" aria-live="polite">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : schedules.length === 0 ? (
            <EmptyState
              icon={Calendar}
              title="No schedules yet"
              description="Add a recurring or one-shot export after a destination exists."
              size="sm"
            />
          ) : (
            <Card padding="lg" className="overflow-hidden">
              <DataTable
                columns={schedColumns}
                rows={schedules}
                rowKey={(s) => s.schedule_id}
                defaultSort={{ key: "last_run_at", direction: "desc" }}
                emptyTitle="No schedules yet"
                emptyDescription="Add a recurring or one-shot export after a destination exists."
                emptyIcon={Calendar}
                pageSize={25}
              />
            </Card>
          )}
        </section>
      )}

      {!error && (
        <section>
          <LegacyExportFallback orgId={orgId} />
        </section>
      )}
      {ConfirmDialog}
    </div>
  );
}
