"use client";

import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/hooks/use-auth";
import { metricStudioApi } from "@/lib/api";
import type { MetricStudioMetric } from "@/lib/api";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { DataTable } from "@/components/ui/data-table";
import { Layers, Loader2, ListChecks, Eye, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  featureGatedErrorCopy,
  featureGatedMessage,
} from "@/lib/feature-flag-error";
import {
  isProduction,
  showStudioMetricsEmpty,
} from "./studio-helpers";

export function MyMetricsTab({
  orgId,
  onError,
}: {
  orgId: string;
  onError: (s: string) => void;
}) {
  const { user } = useAuth();
  const [metrics, setMetrics] = useState<MetricStudioMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [openDetail, setOpenDetail] = useState<MetricStudioMetric | null>(null);
  const [approving, setApproving] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await metricStudioApi.listMetrics(orgId);
      setMetrics(data.metrics);
    } catch (err) {
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }, [orgId]);
  useEffect(() => {
    load();
  }, [load]);
  async function openMetric(metricId: string) {
    try {
      const detail = await metricStudioApi.getMetric(orgId, metricId);
      if (!detail.found || !detail.metric) {
        onError("Metric not found");
        return;
      }
      setOpenDetail(detail.metric);
    } catch (err) {
      onError(featureGatedMessage(err, "Failed to load metric"));
    }
  }
  async function handleApprove() {
    if (!openDetail) return;
    const approvedBy = user?.email?.trim() || user?.user_id;
    if (!approvedBy) {
      onError("Signed-in user email is required to approve.");
      return;
    }
    setApproving(true);
    onError("");
    try {
      await metricStudioApi.approveMetric(orgId, openDetail.metric_id, {
        approved_by: approvedBy,
      });
      setOpenDetail({
        ...openDetail,
        status: "production",
      });
      setMetrics((prev) =>
        prev.map((m) =>
          m.metric_id === openDetail.metric_id ? { ...m, status: "production" } : m,
        ),
      );
    } catch (err) {
      onError(featureGatedMessage(err, "Approval failed"));
    } finally {
      setApproving(false);
    }
  }
  if (loadError && !loading) {
    const copy = featureGatedErrorCopy(loadError, "Could not load metrics");
    return (
      <ErrorState
        title={copy.title}
        message={copy.message}
        action={
          <Button variant="default" className="h-8 max-md:min-h-11" onClick={() => void load()}>
            Try again
          </Button>
        }
      />
    );
  }
  return (
    <div className="space-y-3" data-wave-e5-studio="metrics">
      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--accent)]" />
        </div>
      ) : showStudioMetricsEmpty({
          loading,
          hasError: !!loadError,
          metricCount: metrics.length,
        }) ? (
        <EmptyState
          icon={Layers}
          title="No metrics yet"
          description="Generate one from From examples."
        />
      ) : (
        <div className="overflow-hidden border-y border-[var(--border-subtle)] py-space-2">
          <DataTable
            columns={[
              {
                key: "name",
                header: "Name",
                sortable: true,
                cell: (m) => <span className="font-medium text-[var(--text-primary)]">{m.name}</span>,
              },
              {
                key: "version",
                header: "Version",
                cell: (m) => <span className="text-[var(--text-secondary)] font-mono text-xs">{m.version}</span>,
              },
              {
                key: "created_at",
                header: "Created",
                sortable: true,
                cell: (m) => (
                  <span className="text-[var(--text-muted)] text-xs">
                    {m.created_at ? new Date(m.created_at).toLocaleString() : "—"}
                  </span>
                ),
              },
              {
                key: "status",
                header: "Status",
                cell: (m) =>
                  isProduction(m.status) ? (
                    <span className="inline-flex items-center gap-1 text-xs text-[var(--terminal)]">
                      <CheckCircle2 className="w-3 h-3" aria-hidden />
                      Production
                    </span>
                  ) : (
                    <span className="text-xs text-[var(--text-muted)]">
                      {m.status || "draft"}
                    </span>
                  ),
              },
              {
                key: "metric_id",
                header: "Action",
                align: "right",
                cell: (m) => (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 max-md:min-h-11"
                    onClick={() => openMetric(m.metric_id)}
                    aria-label={`View metric ${m.name}`}
                  >
                    <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                    View
                  </Button>
                ),
              },
            ]}
            rows={metrics}
            rowKey={(m) => m.metric_id}
            defaultSort={{ key: "created_at", direction: "desc" }}
            emptyTitle="No metrics yet"
            emptyDescription="Generate one from From examples."
            emptyIcon={Layers}
            pageSize={25}
          />
        </div>
      )}

      <Dialog open={!!openDetail} onOpenChange={(o) => !o && setOpenDetail(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ListChecks className="w-4 h-4 text-[var(--accent)]" aria-hidden="true" />
              {openDetail?.name}
            </DialogTitle>
            <DialogDescription>
              Domain: {openDetail?.domain ?? "—"} · Version: {openDetail?.version} · Status:{" "}
              {openDetail?.status}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-xs text-[var(--text-secondary)]">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-[var(--bg-secondary)] px-3 py-2">
                <div className="text-2xs font-mono uppercase tracking-wide text-[var(--text-muted)] mb-space-1">Metric ID</div>
                <div className="font-mono break-all">{openDetail?.metric_id}</div>
              </div>
              <div className="rounded-lg bg-[var(--bg-secondary)] px-3 py-2">
                <div className="text-2xs font-mono uppercase tracking-wide text-[var(--text-muted)] mb-space-1">Rubric ID</div>
                <div className="font-mono break-all">{openDetail?.rubric_id}</div>
              </div>
              <div className="rounded-lg bg-[var(--bg-secondary)] px-3 py-2">
                <div className="text-2xs font-mono uppercase tracking-wide text-[var(--text-muted)] mb-space-1">Judge ID</div>
                <div className="font-mono break-all">{openDetail?.judge_id || "—"}</div>
              </div>
              <div className="rounded-lg bg-[var(--bg-secondary)] px-3 py-2">
                <div className="text-2xs font-mono uppercase tracking-wide text-[var(--text-muted)] mb-space-1">Created</div>
                <div>{openDetail?.created_at ? new Date(openDetail.created_at).toLocaleString() : "—"}</div>
              </div>
            </div>
            {(openDetail?.n_scores_30d != null || openDetail?.median_score != null) && (
              <div className="rounded-lg bg-[var(--bg-secondary)] px-3 py-2">
                <div className="text-2xs font-mono uppercase tracking-wide text-[var(--text-muted)] mb-space-1">30-day scores</div>
                <div>
                  n={openDetail?.n_scores_30d ?? 0}
                  {openDetail?.median_score != null ? ` · median ${openDetail.median_score}` : ""}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="h-8 max-md:min-h-11"
              onClick={() => setOpenDetail(null)}
              disabled={approving}
              aria-label="Close metric detail"
            >
              Close
            </Button>
            <Button
              variant="default"
              className="h-8 max-md:min-h-11"
              onClick={handleApprove}
              disabled={isProduction(openDetail?.status)}
              loading={approving}
              aria-label={`Approve metric ${openDetail?.name}`}
            >
              <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
              {isProduction(openDetail?.status) ? "Approved" : "Approve"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
