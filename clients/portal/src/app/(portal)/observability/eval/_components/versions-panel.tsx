"use client";

import { useEffect, useState } from "react";
import { useOrgQuery } from "@/hooks/use-api-query";
import { evalApi, type EvalVersion } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
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
import { Plus, Tag } from "lucide-react";
import {
  featureGatedErrorCopy,
  featureGatedMessage,
} from "@/lib/feature-flag-error";

export function VersionsPanel({
  orgId,
  onError,
}: {
  orgId: string;
  onError: (s: string) => void;
}) {
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
            className="h-8 max-md:min-h-11"
            onClick={() => void versionsQuery.refetch()}
          >
            Try again
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4" data-wave-e5-scores="versions">
      <div className="flex justify-end">
        <Button
          variant="default"
          className="h-8 max-md:min-h-11"
          onClick={() => setTagOpen(true)}
        >
          <Plus className="h-4 w-4" />
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
        <div className="min-w-0 overflow-hidden border-y border-[var(--border-subtle)] py-space-2">
          <DataTable
            columns={[
              {
                key: "deployment_sha",
                header: "Deployment SHA",
                sortable: true,
                cell: (v) => (
                  <span className="font-mono text-xs text-[var(--text-primary)]">
                    {v.deployment_sha || "—"}
                  </span>
                ),
              },
              {
                key: "prompt_version",
                header: "Prompt version",
                sortable: true,
                cell: (v) => (
                  <span className="font-mono text-xs text-[var(--text-secondary)]">
                    {v.prompt_version || "—"}
                  </span>
                ),
              },
              {
                key: "judge_set",
                header: "Judges",
                cell: (v) => (
                  <span className="inline-block max-w-md truncate text-xs text-[var(--text-secondary)]">
                    {(v.judge_set ?? []).join(", ") || "—"}
                  </span>
                ),
              },
              {
                key: "status",
                header: "Status",
                cell: (v) => (
                  <span className="text-xs text-[var(--text-muted)]">{v.status || "—"}</span>
                ),
              },
              {
                key: "created_at",
                header: "Created",
                sortable: true,
                cell: (v) => (
                  <span className="text-xs text-[var(--text-muted)]">
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
        </div>
      )}

      <Dialog open={tagOpen} onOpenChange={(o) => !o && setTagOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tag className="h-4 w-4 text-[var(--accent)]" />
              Tag a new eval version
            </DialogTitle>
            <DialogDescription>
              Record deployment SHA, prompt version, and the judge set for this release.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
                Deployment SHA
              </label>
              <input
                type="text"
                value={form.deployment_sha}
                onChange={(e) => setForm({ ...form, deployment_sha: e.target.value })}
                placeholder="e.g. abcdef1 (7–64 chars)"
                className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
                Prompt version
              </label>
              <input
                type="text"
                value={form.prompt_version}
                onChange={(e) => setForm({ ...form, prompt_version: e.target.value })}
                placeholder="e.g. prompts@1.4.0"
                className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
                Judge set (comma-separated)
              </label>
              <textarea
                value={form.judge_set}
                onChange={(e) => setForm({ ...form, judge_set: e.target.value })}
                rows={3}
                placeholder="helpfulness-judge, safety-judge"
                className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setTagOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="default"
              className="h-8 max-md:min-h-11"
              onClick={handleTag}
              loading={submitting}
            >
              <Tag className="h-3.5 w-3.5" />
              Tag version
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
