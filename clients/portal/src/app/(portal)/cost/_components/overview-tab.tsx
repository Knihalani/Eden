"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  Activity,
  AlertTriangle,
  DollarSign,
  Gauge,
  Wallet,
} from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import type { CostGroupBy } from "@/lib/cost-url";
import { NoOrgState } from "@/components/ui/no-org-state";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  costWindowDays,
  costWindowHours,
  fmtMs,
  fmtPct,
  fmtUsd,
} from "./cost-format";

type DimRow = {
  key?: string;
  day?: string;
  cost_usd: number;
  events: number;
  tokens: number;
};

type ExplorerData = {
  total_cost_usd: number;
  previous_cost_usd: number;
  delta_usd: number;
  delta_pct: number | null;
  by_model: DimRow[];
  by_agent: DimRow[];
  by_day: DimRow[];
  by_feature: DimRow[];
  untagged_events: number;
  cache_savings_usd: number;
  window_hours: number;
};

type OverviewBundle = {
  explorer: ExplorerData;
  overview: Awaited<ReturnType<typeof api.getOptimizationOverview>> | null;
  budget: Awaited<ReturnType<typeof api.getOptimizationBudget>> | null;
  traces: Awaited<ReturnType<typeof api.getOptimizationCostPerTrace>> | null;
};

type Props = {
  pastHours?: string;
  agentId?: string;
  groupBy?: CostGroupBy;
  q?: string;
  onGroupByChange: (groupBy: CostGroupBy) => void;
  onAgentIdChange: (agentId: string | undefined) => void;
};

function SpendBars({
  rows,
  labelFor,
  onRowClick,
}: {
  rows: DimRow[];
  labelFor: (r: DimRow) => string;
  onRowClick?: (r: DimRow) => void;
}) {
  const max = Math.max(...rows.map((r) => r.cost_usd), 1e-9);
  return (
    <ul className="space-y-2" role="list">
      {rows.slice(0, 8).map((r) => {
        const label = labelFor(r);
        const pct = Math.max(2, (r.cost_usd / max) * 100);
        const inner = (
          <>
            <div className="mb-1 flex items-center justify-between gap-2 text-xs">
              <span className="truncate font-mono text-[var(--text-secondary)]">
                {label}
              </span>
              <span className="shrink-0 tabular-nums text-[var(--text-primary)]">
                {fmtUsd(r.cost_usd)}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded bg-[var(--bg-tertiary)]">
              <div
                className="h-full rounded bg-[var(--accent)] motion-reduce:transition-none transition-[width] duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
          </>
        );
        if (!onRowClick) {
          return (
            <li key={label} className="min-w-0">
              {inner}
            </li>
          );
        }
        return (
          <li key={label} className="min-w-0">
            <button
              type="button"
              className="w-full text-left hover:opacity-90"
              onClick={() => onRowClick(r)}
            >
              {inner}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function OverviewTab({
  pastHours,
  agentId,
  groupBy = "model",
  q = "",
  onGroupByChange,
  onAgentIdChange,
}: Props) {
  const t = useTranslations("cost");
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const hours = costWindowHours(pastHours);
  const days = costWindowDays(hours);

  const query = useOrgQuery(
    ["cost", "overview", orgId, hours, agentId ?? null] as const,
    orgId,
    async (): Promise<OverviewBundle> => {
      const [explorerRes, overviewRes, budgetRes, tracesRes] =
        await Promise.allSettled([
          api.finopsExplorer(orgId!, hours),
          api.getOptimizationOverview(orgId!, days),
          api.getOptimizationBudget(orgId!),
          api.getOptimizationCostPerTrace(orgId!, days),
        ]);

      if (explorerRes.status === "rejected") throw explorerRes.reason;

      return {
        explorer: explorerRes.value.data as ExplorerData,
        overview:
          overviewRes.status === "fulfilled" ? overviewRes.value : null,
        budget: budgetRes.status === "fulfilled" ? budgetRes.value : null,
        traces: tracesRes.status === "fulfilled" ? tracesRes.value : null,
      };
    },
  );

  if (!currentOrg) return <NoOrgState feature={t("title")} />;

  const filtersActive = Boolean(agentId || q);

  return (
    <QueryState
      loading={query.isLoading}
      error={query.error}
      data={query.data}
      onRetry={() => void query.refetch()}
      errorTitle={t("errors.loadOverview")}
      filtersActive={filtersActive}
      isEmpty={(d) =>
        d.explorer.total_cost_usd === 0 &&
        (d.explorer.by_model?.length ?? 0) === 0 &&
        (d.traces?.points?.length ?? 0) === 0
      }
      emptyKind={filtersActive ? "filter-empty" : "zero-data"}
      loadingSlot={
        <div className="space-y-4" data-testid="cost-overview-loading">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
          <Skeleton className="h-48 w-full" />
        </div>
      }
      emptySlot={
        <EmptyState
          icon={Wallet}
          title={t("empty.title")}
          description={t("empty.body")}
          action={
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm">
                <Link href="/agents/connect">{t("empty.connect")}</Link>
              </Button>
              <Button asChild size="sm" variant="secondary">
                <Link href="/settings?tab=gateway">{t("empty.gateway")}</Link>
              </Button>
            </div>
          }
        />
      }
      filterEmptySlot={
        <EmptyState
          icon={Wallet}
          title={t("filterEmpty.title")}
          description={t("filterEmpty.body")}
          action={
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => onAgentIdChange(undefined)}
            >
              {t("filterEmpty.clear")}
            </Button>
          }
        />
      }
    >
      {(data) => {
        const ex = data.explorer;
        const ov = data.overview;
        const budget = data.budget;
        const spendUsd =
          ov != null
            ? (ov.costs.total_cost_cents ?? 0) / 100
            : ex.total_cost_usd;
        const requests =
          ex.by_model.reduce((s, r) => s + (r.events ?? 0), 0) ||
          ex.by_agent.reduce((s, r) => s + (r.events ?? 0), 0);
        const avgLatency = ov?.efficiency.p50_latency_ms ?? null;
        const budgetRemaining =
          budget != null
            ? Math.max(0, budget.budget_usd - budget.spent_usd)
            : null;
        const overBudget = budget != null && !budget.on_track;

        let modelRows = ex.by_model ?? [];
        let agentRows = ex.by_agent ?? [];
        if (agentId) {
          agentRows = agentRows.filter(
            (r) => (r.key ?? "").toLowerCase() === agentId.toLowerCase(),
          );
        }
        if (q) {
          const qq = q.toLowerCase();
          modelRows = modelRows.filter((r) =>
            (r.key ?? "").toLowerCase().includes(qq),
          );
          agentRows = agentRows.filter((r) =>
            (r.key ?? "").toLowerCase().includes(qq),
          );
        }

        const secondaryRows =
          groupBy === "agent"
            ? agentRows
            : groupBy === "day"
              ? ex.by_day ?? []
              : groupBy === "provider"
                ? ex.by_feature ?? []
                : modelRows;

        const secondaryLabel =
          groupBy === "agent"
            ? t("overview.byAgent")
            : groupBy === "day"
              ? t("overview.byDay")
              : groupBy === "provider"
                ? t("overview.byProvider")
                : t("overview.byModel");

        let traces = data.traces?.points ?? [];
        if (q) {
          const qq = q.toLowerCase();
          traces = traces.filter(
            (p) =>
              p.trace_id.toLowerCase().includes(qq) ||
              p.model.toLowerCase().includes(qq),
          );
        }
        traces = [...traces].sort((a, b) => b.cost_usd - a.cost_usd).slice(0, 10);

        return (
          <div className="space-y-4" data-testid="cost-overview-panel">
            {overBudget ? (
              <div
                role="status"
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning-bg)] px-3 py-2 text-sm"
                data-testid="cost-over-budget-banner"
              >
                <span className="flex items-center gap-2 text-[var(--warning)]">
                  <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                  {t("overview.overBudget")}
                </span>
                <Button asChild size="sm" variant="secondary">
                  <Link href="/cost?tab=budget">{t("overview.viewBudget")}</Link>
                </Button>
              </div>
            ) : null}

            <div
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
              data-testid="cost-stat-grid"
            >
              <StatCard
                title={t("overview.spend")}
                value={fmtUsd(spendUsd, { compact: true })}
                subtitle={
                  ex.delta_pct != null
                    ? t("overview.vsPrev", { delta: fmtPct(ex.delta_pct) })
                    : undefined
                }
                trend={
                  ex.delta_usd > 0 ? "up" : ex.delta_usd < 0 ? "down" : "flat"
                }
                trendIsGood="down"
                icon={DollarSign}
                accent="accent"
                href="/cost?tab=budget"
              />
              <StatCard
                title={t("overview.requests")}
                value={requests.toLocaleString()}
                icon={Activity}
                accent="neutral"
                href="/traces"
              />
              <StatCard
                title={t("overview.avgLatency")}
                value={avgLatency != null ? fmtMs(avgLatency) : "—"}
                icon={Gauge}
                accent="neutral"
                href="/traces"
              />
              <StatCard
                title={t("overview.cacheSavings")}
                value={fmtUsd(ex.cache_savings_usd, { compact: true })}
                icon={Wallet}
                accent="terminal"
                href="/cost?tab=advisor"
              />
              <StatCard
                title={t("overview.budgetRemaining")}
                value={
                  budgetRemaining != null
                    ? fmtUsd(budgetRemaining, { compact: true })
                    : "—"
                }
                subtitle={
                  budget != null
                    ? t("overview.burnPct", {
                        pct: budget.burn_pct.toFixed(0),
                      })
                    : undefined
                }
                icon={AlertTriangle}
                accent={overBudget ? "warning" : "neutral"}
                href="/cost?tab=budget"
              />
            </div>

            <div className="flex flex-wrap gap-2" data-testid="cost-groupby">
              {(["model", "agent", "provider", "day"] as const).map((g) => (
                <Button
                  key={g}
                  type="button"
                  size="sm"
                  variant={groupBy === g ? "secondary" : "ghost"}
                  onClick={() => onGroupByChange(g)}
                  aria-pressed={groupBy === g}
                >
                  {t(`groupBy.${g}`)}
                </Button>
              ))}
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Panel
                tone="inset"
                padding="md"
                aria-label={t("overview.byModel")}
              >
                <h3 className="mb-3 text-sm font-medium text-[var(--text-primary)]">
                  {t("overview.byModel")}
                </h3>
                {modelRows.length === 0 ? (
                  <p className="text-sm text-[var(--text-muted)]">
                    {t("overview.noBreakdown")}
                  </p>
                ) : (
                  <SpendBars
                    rows={modelRows}
                    labelFor={(r) => r.key || "—"}
                  />
                )}
              </Panel>
              <Panel tone="inset" padding="md" aria-label={secondaryLabel}>
                <h3 className="mb-3 text-sm font-medium text-[var(--text-primary)]">
                  {secondaryLabel}
                </h3>
                {secondaryRows.length === 0 ? (
                  <p className="text-sm text-[var(--text-muted)]">
                    {t("overview.noBreakdown")}
                  </p>
                ) : (
                  <SpendBars
                    rows={secondaryRows}
                    labelFor={(r) => r.key || r.day || "—"}
                    onRowClick={
                      groupBy === "agent"
                        ? (r) => {
                            const id = r.key;
                            if (id) onAgentIdChange(id);
                          }
                        : undefined
                    }
                  />
                )}
              </Panel>
            </div>

            <Panel
              tone="inset"
              padding="md"
              aria-label={t("overview.costlyTraces")}
              data-testid="cost-costly-traces"
            >
              <h3 className="mb-3 text-sm font-medium text-[var(--text-primary)]">
                {t("overview.costlyTraces")}
              </h3>
              {traces.length === 0 ? (
                <p className="text-sm text-[var(--text-muted)]">
                  {t("overview.noTraces")}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[32rem] text-left text-sm">
                    <thead className="text-xs text-[var(--text-muted)]">
                      <tr>
                        <th className="pb-2 pr-3 font-medium">
                          {t("overview.colTrace")}
                        </th>
                        <th className="pb-2 pr-3 font-medium">
                          {t("overview.colModel")}
                        </th>
                        <th className="pb-2 pr-3 font-medium tabular-nums">
                          {t("overview.colCost")}
                        </th>
                        <th className="pb-2 font-medium tabular-nums">
                          {t("overview.colLatency")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {traces.map((p) => {
                        const href = agentId
                          ? `/traces?traceId=${encodeURIComponent(p.trace_id)}&agentId=${encodeURIComponent(agentId)}`
                          : `/traces?traceId=${encodeURIComponent(p.trace_id)}`;
                        return (
                          <tr
                            key={p.trace_id}
                            className="border-t border-[var(--border-subtle)]"
                          >
                            <td className="py-2 pr-3">
                              <Link
                                href={href}
                                className="font-mono text-[var(--accent)] hover:underline"
                                data-testid="cost-trace-link"
                              >
                                {p.trace_id.slice(0, 12)}…
                              </Link>
                            </td>
                            <td className="py-2 pr-3 font-mono text-[var(--text-secondary)]">
                              {p.model}
                            </td>
                            <td className="py-2 pr-3 tabular-nums">
                              {fmtUsd(p.cost_usd)}
                            </td>
                            <td className="py-2 tabular-nums">
                              {fmtMs(p.latency_ms)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>
        );
      }}
    </QueryState>
  );
}
