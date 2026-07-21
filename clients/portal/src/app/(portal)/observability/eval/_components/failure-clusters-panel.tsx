"use client";

import { useState } from "react";
import { evalApi, type EvalFailureCluster } from "@/lib/api";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { DataTable } from "@/components/ui/data-table";
import { Layers, Shield, CheckCircle2 } from "lucide-react";
import { featureGatedMessage } from "@/lib/feature-flag-error";

export function FailureClustersPanel({
  orgId,
  onError,
}: {
  orgId: string;
  onError: (s: string) => void;
}) {
  const [clusters, setClusters] = useState<EvalFailureCluster[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [promoting, setPromoting] = useState<string | null>(null);
  const [openCluster, setOpenCluster] = useState<EvalFailureCluster | null>(null);
  const [judgeName, setJudgeName] = useState("");
  const [window, setWindow] = useState("24h");
  const [emptyMessage, setEmptyMessage] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [promoteForm, setPromoteForm] = useState({ judge_name: "", threshold: 0.5 });

  async function load() {
    onError("");
    setLoadError("");
    if (!judgeName.trim()) {
      onError("Judge name is required.");
      return;
    }
    setLoading(true);
    try {
      const data = await evalApi.failureClusters(orgId, {
        judge_name: judgeName.trim(),
        window: window.trim() || "24h",
      });
      setClusters(data.clusters ?? []);
      setEmptyMessage(data.message ?? null);
      setHasLoaded(true);
    } catch (err) {
      const msg = featureGatedMessage(err, "Failed to load clusters");
      setLoadError(msg);
      onError(msg);
    } finally {
      setLoading(false);
    }
  }

  async function handlePromote() {
    if (!openCluster) return;
    onError("");
    if (!promoteForm.judge_name.trim()) {
      onError("Judge name is required.");
      return;
    }
    setPromoting(openCluster.cluster_id);
    try {
      await evalApi.promoteToGuardrail(orgId, {
        judge_name: promoteForm.judge_name.trim(),
        threshold: promoteForm.threshold,
      });
      setOpenCluster(null);
      setPromoteForm({ judge_name: "", threshold: 0.5 });
    } catch (err) {
      onError(featureGatedMessage(err, "Promote failed"));
    } finally {
      setPromoting(null);
    }
  }

  return (
    <div className="space-y-4" data-wave-e5-scores="clusters">
      <div className="space-y-3 border-b border-[var(--border-subtle)] pb-space-3">
        <p className="text-xs text-[var(--text-muted)]">
          Cluster low-score traces for a judge over a time window (e.g. 24h, 7d).
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
              Judge name
            </label>
            <input
              type="text"
              value={judgeName}
              onChange={(e) => setJudgeName(e.target.value)}
              placeholder="e.g. helpfulness-judge"
              className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
              Window
            </label>
            <input
              type="text"
              value={window}
              onChange={(e) => setWindow(e.target.value)}
              placeholder="24h"
              className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="h-8 max-md:min-h-11"
          onClick={() => void load()}
          loading={loading}
        >
          <Layers className="h-3.5 w-3.5" />
          {hasLoaded ? "Refresh" : "Find clusters"}
        </Button>
      </div>

      {!hasLoaded && !loading ? (
        <EmptyState
          icon={Layers}
          title="No clusters loaded"
          description="Enter a judge name and click “Find clusters”."
          size="lg"
        />
      ) : loadError && clusters.length === 0 ? (
        <ErrorState
          title="Could not load failure clusters"
          message={loadError}
          action={
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      ) : loading && clusters.length === 0 ? (
        <div className="space-y-3 py-6" aria-busy="true" aria-live="polite">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ) : clusters.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="No failures clustered"
          description={emptyMessage || "No failure modes found in this window."}
          size="md"
        />
      ) : (
        <div className="min-w-0 overflow-hidden border-y border-[var(--border-subtle)] py-space-2">
          <DataTable
            columns={[
              {
                key: "cluster_id",
                header: "Cluster",
                sortable: true,
                cell: (c) => (
                  <span className="font-mono text-xs text-[var(--text-primary)]">
                    {c.cluster_id}
                  </span>
                ),
              },
              {
                key: "member_count",
                header: "Size",
                sortable: true,
                align: "right",
                cell: (c) => (
                  <span className="text-[var(--text-secondary)]">{c.member_count}</span>
                ),
              },
              {
                key: "sample_score",
                header: "Avg score",
                sortable: true,
                align: "right",
                cell: (c) => (
                  <span className="text-xs text-[var(--text-muted)]">
                    {c.sample_score.toFixed(3)}
                  </span>
                ),
              },
              {
                key: "signature",
                header: "Signature",
                cell: (c) => (
                  <span className="inline-block max-w-xl truncate text-[var(--text-secondary)]">
                    {c.signature}
                  </span>
                ),
              },
              {
                key: "actions",
                header: "",
                align: "right",
                cell: (c) => (
                  <Button
                    variant="default"
                    size="sm"
                    className="h-8 max-md:min-h-11"
                    onClick={() => {
                      setOpenCluster(c);
                      setPromoteForm({ judge_name: judgeName.trim(), threshold: 0.5 });
                    }}
                  >
                    <Shield className="h-3.5 w-3.5" />
                    Promote to guardrail
                  </Button>
                ),
              },
            ]}
            rows={clusters}
            rowKey={(c) => c.cluster_id}
            defaultSort={{ key: "member_count", direction: "desc" }}
            pageSize={25}
          />
        </div>
      )}

      <Dialog open={!!openCluster} onOpenChange={(o) => !o && setOpenCluster(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-[var(--accent)]" />
              Promote cluster to guardrail
            </DialogTitle>
            <DialogDescription>
              Cluster {openCluster?.cluster_id} ({openCluster?.member_count} failures)
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
                Judge name
              </label>
              <input
                type="text"
                value={promoteForm.judge_name}
                onChange={(e) =>
                  setPromoteForm({ ...promoteForm, judge_name: e.target.value })
                }
                placeholder="e.g. helpfulness-judge"
                className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
                Threshold (0-1)
              </label>
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={promoteForm.threshold}
                onChange={(e) =>
                  setPromoteForm({
                    ...promoteForm,
                    threshold: Number(e.target.value),
                  })
                }
                className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpenCluster(null)}>
              Cancel
            </Button>
            <Button
              variant="default"
              className="h-8 max-md:min-h-11"
              onClick={handlePromote}
              loading={!!promoting}
            >
              <Shield className="h-3.5 w-3.5" />
              Promote
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
