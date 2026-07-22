"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { LineChart } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { outcomesApi } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import {
  assertOkEnvelope,
} from "@/lib/feature-flag-error";
import { NoOrgState } from "@/components/ui/no-org-state";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { DollarSign, TrendingUp, AlertTriangle } from "lucide-react";
import { fmtUsd } from "./cost-format";

type DeptRow = {
  department: string;
  cost_usd: number;
  outcomes_value_usd: number;
  net_roi: number | null;
  outcome_count: number;
  alert: string | null;
};

type OutcomesBundle = {
  departments: DeptRow[];
  totalCost: number;
  totalValue: number;
  netRoi: number | null;
  anomalies: number;
};

type Props = {
  agentId?: string;
};

export function OutcomesTab({ agentId }: Props) {
  const t = useTranslations("cost");
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;

  const query = useOrgQuery(
    queryKeys.outcomes.departments(orgId),
    orgId,
    async (): Promise<OutcomesBundle> => {
      const [deptRes, analyticsRes] = await Promise.allSettled([
        outcomesApi.listDepartments(orgId!),
        outcomesApi.getAnalytics(orgId!),
      ]);
      if (deptRes.status === "rejected") throw deptRes.reason;
      const payload = assertOkEnvelope(
        deptRes.value,
        t("errors.loadOutcomes"),
      );
      const departments = (payload.departments ?? []).map((d) => ({
        department: d.department,
        cost_usd: d.cost_usd ?? 0,
        outcomes_value_usd: d.outcomes_value_usd ?? 0,
        net_roi: d.net_roi,
        outcome_count: d.outcome_count ?? 0,
        alert: d.alert,
      }));
      let anomalies = departments.filter((d) => d.alert).length;
      let totalCost = payload.totals?.cost_usd ?? 0;
      let totalValue = payload.totals?.outcomes_value_usd ?? 0;
      let netRoi = payload.totals?.net_roi ?? null;
      if (analyticsRes.status === "fulfilled") {
        try {
          const analytics = assertOkEnvelope(
            analyticsRes.value,
            t("errors.loadOutcomes"),
          );
          anomalies = Math.max(
            anomalies,
            analytics.anomalies?.length ?? 0,
          );
          totalCost = analytics.summary?.total_cost_usd ?? totalCost;
          totalValue = analytics.summary?.total_value_usd ?? totalValue;
          netRoi = analytics.summary?.net_roi ?? netRoi;
        } catch {
          /* analytics optional */
        }
      }
      return { departments, totalCost, totalValue, netRoi, anomalies };
    },
  );

  if (!currentOrg) return <NoOrgState feature={t("outcomes.title")} />;

  const improveHref = agentId
    ? `/improve?tab=queue&agentId=${encodeURIComponent(agentId)}`
    : "/improve?tab=queue";
  const tracesHref = agentId
    ? `/traces?agentId=${encodeURIComponent(agentId)}`
    : "/traces";

  return (
    <QueryState
      loading={query.isLoading}
      error={query.error}
      data={query.data}
      onRetry={() => void query.refetch()}
      errorTitle={t("errors.loadOutcomes")}
      isEmpty={(d) => d.departments.length === 0 && d.totalCost === 0}
      loadingSlot={
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      }
      emptySlot={
        <EmptyState
          icon={LineChart}
          title={t("outcomes.emptyTitle")}
          description={t("outcomes.emptyBody")}
          action={
            <Button asChild size="sm" variant="secondary">
              <Link href={tracesHref}>{t("outcomes.openTraces")}</Link>
            </Button>
          }
        />
      }
    >
      {(data) => (
        <div className="space-y-4" data-testid="cost-outcomes-panel">
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard
              title={t("outcomes.spend")}
              value={fmtUsd(data.totalCost, { compact: true })}
              icon={DollarSign}
              href={tracesHref}
            />
            <StatCard
              title={t("outcomes.value")}
              value={fmtUsd(data.totalValue, { compact: true })}
              icon={TrendingUp}
              href={improveHref}
            />
            <StatCard
              title={t("outcomes.anomalies")}
              value={String(data.anomalies)}
              icon={AlertTriangle}
              accent={data.anomalies > 0 ? "warning" : "neutral"}
              href={improveHref}
            />
          </div>

          <Panel tone="inset" padding="md">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">{t("outcomes.tableTitle")}</h3>
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" variant="secondary">
                  <Link href={tracesHref}>{t("outcomes.openTraces")}</Link>
                </Button>
                <Button asChild size="sm" variant="ghost">
                  <Link href={improveHref}>{t("outcomes.openImprove")}</Link>
                </Button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-left text-sm">
                <thead className="text-xs text-[var(--text-muted)]">
                  <tr>
                    <th className="pb-2 pr-3 font-medium">
                      {t("outcomes.colDept")}
                    </th>
                    <th className="pb-2 pr-3 font-medium tabular-nums">
                      {t("outcomes.colCost")}
                    </th>
                    <th className="pb-2 pr-3 font-medium tabular-nums">
                      {t("outcomes.colValue")}
                    </th>
                    <th className="pb-2 pr-3 font-medium tabular-nums">
                      {t("outcomes.colRoi")}
                    </th>
                    <th className="pb-2 font-medium">{t("outcomes.colAlert")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.departments.map((d) => (
                    <tr
                      key={d.department}
                      className="border-t border-[var(--border-subtle)]"
                    >
                      <td className="py-2 pr-3 font-medium">{d.department}</td>
                      <td className="py-2 pr-3 tabular-nums">
                        {fmtUsd(d.cost_usd)}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {fmtUsd(d.outcomes_value_usd)}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {d.net_roi != null ? d.net_roi.toFixed(2) : "—"}
                      </td>
                      <td className="py-2 text-[var(--text-secondary)]">
                        {d.alert ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      )}
    </QueryState>
  );
}
