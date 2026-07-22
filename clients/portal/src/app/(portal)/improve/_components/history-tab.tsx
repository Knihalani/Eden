"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { History } from "lucide-react";
import { improveRunsApi, learnApi, type ImprovementRun } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { Panel } from "@/components/ui/panel";
import { formatRelativeTime } from "@/lib/format";
import { useImproveUrlState } from "../_hooks/use-improve-url-state";

export type HistoryTabProps = {
  canMutate: boolean;
};

export function HistoryTab({ canMutate: _canMutate }: HistoryTabProps) {
  const t = useTranslations("improve");
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const { state, setState } = useImproveUrlState();

  const runsQuery = useOrgQuery(
    queryKeys.improve.runs(orgId),
    orgId,
    () => improveRunsApi.listRuns(orgId!),
  );

  const scorecardQuery = useOrgQuery(
    ["improve", "scorecard", orgId] as const,
    orgId,
    () => learnApi.getScorecard(orgId!),
  );

  const runs = useMemo(() => {
    const list = runsQuery.data?.data?.runs ?? [];
    const q = (state.q ?? "").trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (r) =>
        r.id.toLowerCase().includes(q) ||
        (r.agent_id ?? "").toLowerCase().includes(q) ||
        r.status.toLowerCase().includes(q),
    );
  }, [runsQuery.data, state.q]);

  const columns: DataTableColumn<ImprovementRun>[] = [
    {
      key: "id",
      header: t("history.col.id"),
      cell: (row) => (
        <span className="font-mono text-xs text-[var(--text-primary)]">
          {row.id}
        </span>
      ),
    },
    {
      key: "status",
      header: t("history.col.status"),
      cell: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: "agent",
      header: t("history.col.agent"),
      cell: (row) => row.agent_id ?? "—",
    },
    {
      key: "plans",
      header: t("history.col.plans"),
      align: "right",
      cell: (row) => String(row.plans_created ?? 0),
    },
    {
      key: "started",
      header: t("history.col.started"),
      cell: (row) => formatRelativeTime(row.started_at || row.last_run_at),
    },
  ];

  const metrics = scorecardQuery.data?.data?.metrics;

  return (
    <div className="space-y-4" data-testid="improve-history-tab">
      {metrics ? (
        <Panel tone="flat" padding="md" data-testid="improve-scorecard-peek">
          <h3 className="mb-2 text-sm font-medium text-[var(--text-primary)]">
            {t("history.scorecard")}
          </h3>
          <pre className="max-h-40 overflow-auto font-mono text-xs text-[var(--text-secondary)]">
            {JSON.stringify(metrics, null, 2)}
          </pre>
        </Panel>
      ) : null}

      <QueryState
        loading={runsQuery.isLoading}
        error={runsQuery.error}
        data={runs}
        onRetry={() => void runsQuery.refetch()}
        isEmpty={(r) => r.length === 0}
        filtersActive={Boolean(state.q)}
        loadingSlot={
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        }
        emptySlot={
          <EmptyState
            icon={History}
            title={t("history.empty.title")}
            description={t("history.empty.body")}
            action={
              <Button asChild size="sm" className="min-h-11">
                <Link href="/improve?tab=queue">{t("history.empty.cta")}</Link>
              </Button>
            }
          />
        }
        filterEmptySlot={
          <EmptyState
            title={t("history.filterEmpty.title")}
            description={t("history.filterEmpty.body")}
            action={
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="min-h-11"
                onClick={() => setState({ q: undefined })}
              >
                {t("history.filterEmpty.clear")}
              </Button>
            }
          />
        }
      >
        {(data) => (
          <DataTable columns={columns} rows={data} rowKey={(r) => r.id} />
        )}
      </QueryState>
    </div>
  );
}
