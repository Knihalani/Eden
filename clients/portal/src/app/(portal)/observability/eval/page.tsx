"use client";

import { useEffect, useState } from "react";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { evalApi, type EvalFailureCluster, type EvalVersion } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageContent } from "@/components/layout/page-content";
import { ObserveLeafHeader } from "@/app/(portal)/observability/_components/observe-leaf-shell";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { DataTable } from "@/components/ui/data-table";
import { BarChart3, Gauge, Plus, Tag, Layers, Shield, CheckCircle2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import {
  featureGatedErrorCopy,
  featureGatedMessage,
} from "@/lib/feature-flag-error";

type Tab = "versions" | "clusters";

export default function EvalPage() {
  const { currentOrg } = useOrg();
  const [activeTab, setActiveTab] = useState<Tab>("versions");
  const [error, setError] = useState("");

  return (
    <PageContent size="wide">
      <ObserveLeafHeader title="Evaluation" subtitle="Judge versions and failure clusters" icon={BarChart3} />

      {error ? (
        <ErrorState
          title="Evaluation request failed"
          message={error}
          action={
            <Button size="sm" variant="outline" onClick={() => setError("")}>
              Dismiss
            </Button>
          }
        />
      ) : null}

      {!currentOrg ? (
        <NoOrgState
          icon={Gauge}
          feature="Evaluation Quality"
          description="Choose an organization to manage judge versions and failure clusters."
        />
      ) : (
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as Tab)}>
          <TabsList
            variant="underline"
            aria-label="Evaluation sections"
            className="h-auto w-full justify-start gap-1 bg-transparent border-b border-[var(--border-default)]"
          >
            {(
              [
                { key: "versions" as Tab, label: "Versions", icon: Tag },
                { key: "clusters" as Tab, label: "Failure clusters", icon: Layers },
              ] as const
            ).map(({ key, label, icon: Icon }) => (
              <TabsTrigger
                key={key}
                value={key}
                variant="underline"
                className="flex items-center gap-2"
              >
                <Icon className="w-4 h-4" aria-hidden />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>

          {activeTab === "versions" && <VersionsTab orgId={currentOrg.id} onError={setError} />}
          {activeTab === "clusters" && <FailureClustersTab orgId={currentOrg.id} onError={setError} />}
        </Tabs>
      )}
    </PageContent>
  );
}

function VersionsTab({ orgId, onError }: { orgId: string; onError: (s: string) => void }) {
  const [tagOpen, setTagOpen] = useState(false);
  const [form, setForm] = useState({
    deployment_sha: "",
    prompt_version: "",
    judge_set: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const versionsQuery = useOrgQuery(queryKeys.eval.versions(orgId), orgId, async () => {
    const data = await evalApi.listVersions(orgId);
    return data.versions ?? [];
  });
  const versions: EvalVersion[] = versionsQuery.data ?? [];
  const loading = versionsQuery.isLoading;

  useEffect(() => {
    if (versionsQuery.error) {
      onError(featureGatedMessage(versionsQuery.error, "Failed to load versions"));
    }
  }, [versionsQuery.error, onError]);

  async function handleTag() {
    onError("");
    const judges = form.judge_set
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!form.deployment_sha.trim() || !form.prompt_version.trim() || judges.length === 0) {
      onError("Deployment SHA, prompt version, and at least one judge are required.");
      return;
    }
    setSubmitting(true);
    try {
      await evalApi.tagVersion(orgId, {
        deployment_sha: form.deployment_sha.trim(),
        prompt_version: form.prompt_version.trim(),
        judge_set: judges,
      });
      setTagOpen(false);
      setForm({ deployment_sha: "", prompt_version: "", judge_set: "" });
      await versionsQuery.refetch();
    } catch (err) {
      onError(featureGatedMessage(err, "Tag failed"));
    } finally {
      setSubmitting(false);
    }
  }

  if (versionsQuery.error && !loading) {
    const copy = featureGatedErrorCopy(
      versionsQuery.error,
      "Could not load eval versions",
    );
    return (
      <ErrorState
        title={copy.title}
        message={copy.message}
        action={
          <Button
            variant="default"
            className="min-h-11"
            onClick={() => void versionsQuery.refetch()}
          >
            Try again
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="default" className="min-h-11" onClick={() => setTagOpen(true)}>
          <Plus className="w-4 h-4" />
          Tag new version
        </Button>
      </div>

      {loading ? (
        <div className="space-y-3 py-6" aria-busy="true" aria-live="polite">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ) : versions.length === 0 ? (
        <EmptyState
          icon={Tag}
          title="No versions tagged"
          description="Tag a deployment SHA with its prompt version and judge set to start tracking eval lineage."
          size="lg"
        />
      ) : (
        <Card padding="lg" className="overflow-hidden">
          <DataTable
            columns={[
              {
                key: "deployment_sha",
                header: "Deployment SHA",
                sortable: true,
                cell: (v) => (
                  <span className="font-mono text-xs text-[var(--text-primary)]">{v.deployment_sha || "—"}</span>
                ),
              },
              {
                key: "prompt_version",
                header: "Prompt version",
                sortable: true,
                cell: (v) => (
                  <span className="font-mono text-xs text-[var(--text-secondary)]">{v.prompt_version || "—"}</span>
                ),
              },
              {
                key: "judge_set",
                header: "Judges",
                cell: (v) => (
                  <span className="text-[var(--text-secondary)] text-xs max-w-md truncate inline-block">
                    {(v.judge_set ?? []).join(", ") || "—"}
                  </span>
                ),
              },
              {
                key: "status",
                header: "Status",
                cell: (v) => <span className="text-xs text-[var(--text-muted)]">{v.status || "—"}</span>,
              },
              {
                key: "created_at",
                header: "Created",
                sortable: true,
                cell: (v) => (
                  <span className="text-[var(--text-muted)] text-xs">
                    {v.created_at ? new Date(v.created_at).toLocaleString() : "—"}
                  </span>
                ),
              },
            ]}
            rows={versions}
            rowKey={(v) => v.id ?? `${v.deployment_sha ?? "sha"}-${v.created_at ?? "t"}`}
            defaultSort={{ key: "created_at", direction: "desc" }}
            pageSize={25}
          />
        </Card>
      )}

      <Dialog open={tagOpen} onOpenChange={(o) => !o && setTagOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tag className="w-4 h-4 text-[var(--accent)]" />
              Tag a new eval version
            </DialogTitle>
            <DialogDescription>
              Record deployment SHA, prompt version, and the judge set for this release.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Deployment SHA</label>
              <input
                type="text"
                value={form.deployment_sha}
                onChange={(e) => setForm({ ...form, deployment_sha: e.target.value })}
                placeholder="e.g. abcdef1 (7–64 chars)"
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] font-mono"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Prompt version</label>
              <input
                type="text"
                value={form.prompt_version}
                onChange={(e) => setForm({ ...form, prompt_version: e.target.value })}
                placeholder="e.g. prompts@1.4.0"
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Judge set (comma-separated)</label>
              <textarea
                value={form.judge_set}
                onChange={(e) => setForm({ ...form, judge_set: e.target.value })}
                rows={3}
                placeholder="helpfulness-judge, safety-judge"
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setTagOpen(false)}>
              Cancel
            </Button>
            <Button variant="default" className="min-h-11" onClick={handleTag} loading={submitting}>
              <Tag className="w-3.5 h-3.5" />
              Tag version
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FailureClustersTab({ orgId, onError }: { orgId: string; onError: (s: string) => void }) {
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
    <div className="space-y-4">
      <Card padding="lg" className="space-y-3">
        <p className="text-xs text-[var(--text-muted)]">
          Cluster low-score traces for a judge over a time window (e.g. 24h, 7d).
        </p>
        <div className="grid sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Judge name</label>
            <input
              type="text"
              value={judgeName}
              onChange={(e) => setJudgeName(e.target.value)}
              placeholder="e.g. helpfulness-judge"
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Window</label>
            <input
              type="text"
              value={window}
              onChange={(e) => setWindow(e.target.value)}
              placeholder="24h"
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="min-h-11"
          onClick={() => void load()}
          loading={loading}
        >
          <Layers className="w-3.5 h-3.5" />
          {hasLoaded ? "Refresh" : "Find clusters"}
        </Button>
      </Card>

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
        <Card padding="lg" className="overflow-hidden">
          <DataTable
            columns={[
              {
                key: "cluster_id",
                header: "Cluster",
                sortable: true,
                cell: (c) => <span className="font-mono text-xs text-[var(--text-primary)]">{c.cluster_id}</span>,
              },
              {
                key: "member_count",
                header: "Size",
                sortable: true,
                align: "right",
                cell: (c) => <span className="text-[var(--text-secondary)]">{c.member_count}</span>,
              },
              {
                key: "sample_score",
                header: "Avg score",
                sortable: true,
                align: "right",
                cell: (c) => <span className="text-xs text-[var(--text-muted)]">{c.sample_score.toFixed(3)}</span>,
              },
              {
                key: "signature",
                header: "Signature",
                cell: (c) => (
                  <span className="text-[var(--text-secondary)] max-w-xl truncate inline-block">{c.signature}</span>
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
                    className="min-h-11"
                    onClick={() => {
                      setOpenCluster(c);
                      setPromoteForm({ judge_name: judgeName.trim(), threshold: 0.5 });
                    }}
                  >
                    <Shield className="w-3.5 h-3.5" />
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
        </Card>
      )}

      <Dialog open={!!openCluster} onOpenChange={(o) => !o && setOpenCluster(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-[var(--accent)]" />
              Promote cluster to guardrail
            </DialogTitle>
            <DialogDescription>
              Cluster {openCluster?.cluster_id} ({openCluster?.member_count} failures)
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Judge name</label>
              <input
                type="text"
                value={promoteForm.judge_name}
                onChange={(e) => setPromoteForm({ ...promoteForm, judge_name: e.target.value })}
                placeholder="e.g. helpfulness-judge"
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Threshold (0-1)</label>
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={promoteForm.threshold}
                onChange={(e) => setPromoteForm({ ...promoteForm, threshold: Number(e.target.value) })}
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpenCluster(null)}>
              Cancel
            </Button>
            <Button variant="default" className="min-h-11" onClick={handlePromote} loading={!!promoting}>
              <Shield className="w-3.5 h-3.5" />
              Promote
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
