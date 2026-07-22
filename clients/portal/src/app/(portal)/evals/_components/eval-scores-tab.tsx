"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Layers, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { QueryState } from "@/components/ui/query-state";
import {
  useEvalScoresTab,
  type FailureClusterRow,
} from "../_hooks/use-eval-scores-tab";

export type EvalScoresTabProps = {
  canMutate?: boolean;
};

function clusterIssueHref(c: FailureClusterRow): string | null {
  if (c.issue_id) return `/issues/${encodeURIComponent(c.issue_id)}`;
  return null;
}

function clusterTraceHref(c: FailureClusterRow): string | null {
  const traceId = c.trace_id || c.sample_trace_ids?.[0];
  if (!traceId) return null;
  return `/traces?traceId=${encodeURIComponent(traceId)}&mode=scores`;
}

export function EvalScoresTab({ canMutate = true }: EvalScoresTabProps) {
  const t = useTranslations("evals");
  const scores = useEvalScoresTab();

  return (
    <div className="space-y-6" data-testid="evals-scores-tab">
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-[var(--text-primary)]">
            {t("scores.versionsTitle")}
          </h2>
          {!canMutate ? (
            <span className="text-xs text-[var(--text-muted)]">
              {t("viewerReadonly")}
            </span>
          ) : null}
        </div>
        <QueryState
          loading={scores.versionsQuery.isLoading}
          error={scores.versionsQuery.error}
          data={scores.versions}
          onRetry={() => void scores.versionsQuery.refetch()}
          isEmpty={(rows) => rows.length === 0}
          emptySlot={
            <EmptyState
              icon={Tag}
              title={t("scores.versionsEmptyTitle")}
              description={t("scores.versionsEmptyBody")}
              variant="plain"
            />
          }
        >
          {(versions) => (
            <DataTable
              rows={versions}
              rowKey={(v) =>
                v.id ?? `${v.deployment_sha ?? "sha"}-${v.created_at ?? "t"}`
              }
              defaultSort={{ key: "created_at", direction: "desc" }}
              columns={[
                {
                  key: "deployment_sha",
                  header: t("scores.colDeployment"),
                  sortable: true,
                  cell: (v) => (
                    <span className="font-mono text-xs">
                      {v.deployment_sha || "—"}
                    </span>
                  ),
                },
                {
                  key: "prompt_version",
                  header: t("scores.colPrompt"),
                  sortable: true,
                  cell: (v) => (
                    <span className="font-mono text-xs text-[var(--text-secondary)]">
                      {v.prompt_version || "—"}
                    </span>
                  ),
                },
                {
                  key: "judge_set",
                  header: t("scores.colJudges"),
                  cell: (v) => (
                    <span className="inline-block max-w-md truncate text-xs text-[var(--text-secondary)]">
                      {(v.judge_set ?? []).join(", ") || "—"}
                    </span>
                  ),
                },
                {
                  key: "status",
                  header: t("scores.colStatus"),
                  cell: (v) =>
                    v.status ? (
                      <Badge variant="secondary">{v.status}</Badge>
                    ) : (
                      "—"
                    ),
                },
                {
                  key: "created_at",
                  header: t("scores.colCreated"),
                  sortable: true,
                  cell: (v) => (
                    <span className="text-xs text-[var(--text-muted)]">
                      {v.created_at
                        ? new Date(v.created_at).toLocaleString()
                        : "—"}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </QueryState>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-[var(--text-primary)]">
          {t("scores.clustersTitle")}
        </h2>
        <Panel tone="flat" padding="md" className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-[var(--text-muted)]">
                {t("scores.judgeName")}
              </span>
              <Input
                value={scores.judgeName}
                onChange={(e) => scores.setJudgeName(e.target.value)}
                placeholder={t("scores.judgeNamePlaceholder")}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-[var(--text-muted)]">
                {t("scores.window")}
              </span>
              <Input
                value={scores.window}
                onChange={(e) => scores.setWindow(e.target.value)}
                placeholder="24h"
              />
            </label>
          </div>
          <Button
            type="button"
            variant="secondary"
            className="min-h-11"
            loading={scores.clustersMutation.isPending}
            onClick={() => scores.findClusters()}
          >
            <Layers className="h-3.5 w-3.5" aria-hidden />
            {scores.hasLoadedClusters
              ? t("scores.refreshClusters")
              : t("scores.findClusters")}
          </Button>
        </Panel>

        {!scores.hasLoadedClusters && !scores.clustersMutation.isPending ? (
          <EmptyState
            icon={Layers}
            title={t("scores.clustersIdleTitle")}
            description={t("scores.clustersIdleBody")}
            variant="plain"
          />
        ) : scores.clustersMutation.isPending && scores.clusters.length === 0 ? (
          <QueryState
            loading
            error={null}
            data={null}
            isEmpty={() => true}
            emptySlot={null}
          >
            {() => null}
          </QueryState>
        ) : scores.clusters.length === 0 ? (
          <EmptyState
            icon={Layers}
            title={t("scores.clustersEmptyTitle")}
            description={
              scores.clustersMeta?.message || t("scores.clustersEmptyBody")
            }
            variant="plain"
          />
        ) : (
          <DataTable
            rows={scores.clusters}
            rowKey={(c) => c.cluster_id}
            defaultSort={{ key: "member_count", direction: "desc" }}
            columns={[
              {
                key: "cluster_id",
                header: t("scores.colCluster"),
                sortable: true,
                cell: (c) => (
                  <span className="font-mono text-xs">{c.cluster_id}</span>
                ),
              },
              {
                key: "member_count",
                header: t("scores.colSize"),
                sortable: true,
                align: "right",
              },
              {
                key: "sample_score",
                header: t("scores.colAvgScore"),
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
                header: t("scores.colSignature"),
                cell: (c) => (
                  <span className="inline-block max-w-xl truncate text-[var(--text-secondary)]">
                    {c.signature}
                  </span>
                ),
              },
              {
                key: "links",
                header: "",
                align: "right",
                cell: (c) => {
                  const issueHref = clusterIssueHref(c);
                  const traceHref = clusterTraceHref(c);
                  if (!issueHref && !traceHref) return null;
                  return (
                    <div className="flex justify-end gap-2">
                      {issueHref ? (
                        <Button asChild size="sm" variant="outline" className="min-h-11">
                          <Link href={issueHref}>{t("scores.openIssue")}</Link>
                        </Button>
                      ) : null}
                      {traceHref ? (
                        <Button asChild size="sm" variant="outline" className="min-h-11">
                          <Link href={traceHref}>{t("scores.openTrace")}</Link>
                        </Button>
                      ) : null}
                    </div>
                  );
                },
              },
            ]}
          />
        )}
      </section>
    </div>
  );
}
