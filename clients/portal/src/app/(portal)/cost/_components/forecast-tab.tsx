"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Sparkles, Wallet } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { api, predictiveApi } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { assertOkEnvelope } from "@/lib/feature-flag-error";
import { NoOrgState } from "@/components/ui/no-org-state";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/ui/panel";
import { StatCard } from "@/components/ui/stat-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { costWindowDays, costWindowHours, fmtUsd } from "./cost-format";

type ForecastPoint = {
  date: string;
  predicted_cost_usd: number;
  ci_95_low: number;
  ci_95_high: number;
};

type ForecastBundle = {
  predictions: ForecastPoint[];
  predicted_cost_usd: number | null;
  confidence: number | null;
  message?: string;
  overviewNext7d: number | null;
  overviewNext30d: number | null;
};

type Props = {
  pastHours?: string;
  agentId?: string;
};

function ForecastLine({ data }: { data: ForecastPoint[] }) {
  if (data.length === 0) return null;
  const width = 720;
  const height = 200;
  const padX = 40;
  const padY = 24;
  const xs = data.map((d) => new Date(d.date).getTime());
  const ys = data.flatMap((d) => [
    d.ci_95_low,
    d.ci_95_high,
    d.predicted_cost_usd,
  ]);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const yRange = Math.max(1e-9, yMax - yMin);
  const xRange = Math.max(1, xMax - xMin);
  const xScale = (t: number) =>
    padX + ((t - xMin) / xRange) * (width - padX * 2);
  const yScale = (v: number) =>
    height - padY - ((v - yMin) / yRange) * (height - padY * 2);

  const linePath = data
    .map((d, i) => {
      const x = xScale(new Date(d.date).getTime());
      const y = yScale(d.predicted_cost_usd);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  const bandPath = (() => {
    const top = data
      .map((d, i) => {
        const x = xScale(new Date(d.date).getTime());
        const y = yScale(d.ci_95_high);
        return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
    const bottom = [...data]
      .reverse()
      .map((d) => {
        const x = xScale(new Date(d.date).getTime());
        const y = yScale(d.ci_95_low);
        return `L ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
    return `${top} ${bottom} Z`;
  })();

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full motion-reduce:transition-none"
      style={{ height }}
      role="img"
      aria-label="Forecast"
    >
      <path d={bandPath} fill="var(--accent)" opacity={0.15} />
      <path
        d={linePath}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={2}
      />
    </svg>
  );
}

export function ForecastTab({ pastHours, agentId }: Props) {
  const t = useTranslations("cost");
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const hours = costWindowHours(pastHours);
  const days = costWindowDays(hours);

  const query = useOrgQuery(
    queryKeys.predict.cost(orgId, { days }),
    orgId,
    async (): Promise<ForecastBundle> => {
      const [predRes, overviewRes] = await Promise.allSettled([
        predictiveApi.cost(orgId!, {
          horizon_days: 30,
          forecast_horizon: "30d",
          history_window: `${days}d`,
        }),
        api.getOptimizationOverview(orgId!, days),
      ]);
      if (predRes.status === "rejected") throw predRes.reason;
      const payload = assertOkEnvelope(predRes.value, t("errors.loadForecast"));
      const overview =
        overviewRes.status === "fulfilled" ? overviewRes.value : null;
      return {
        predictions: payload.predictions ?? [],
        predicted_cost_usd: payload.predicted_cost_usd,
        confidence: payload.confidence,
        message: payload.message,
        overviewNext7d:
          overview != null ? overview.forecast.next_7d_cost_cents / 100 : null,
        overviewNext30d:
          overview != null ? overview.forecast.next_30d_cost_cents / 100 : null,
      };
    },
  );

  if (!currentOrg) return <NoOrgState feature={t("forecast.title")} />;

  const budgetHref = "/cost?tab=budget";
  const advisorHref = agentId
    ? `/cost?tab=advisor&agentId=${encodeURIComponent(agentId)}`
    : "/cost?tab=advisor";

  return (
    <QueryState
      loading={query.isLoading}
      error={query.error}
      data={query.data}
      onRetry={() => void query.refetch()}
      errorTitle={t("errors.loadForecast")}
      isEmpty={(d) =>
        (d.predictions?.length ?? 0) === 0 &&
        d.predicted_cost_usd == null &&
        d.overviewNext30d == null
      }
      loadingSlot={
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      }
      emptySlot={
        <EmptyState
          icon={Sparkles}
          title={t("forecast.emptyTitle")}
          description={t("forecast.emptyBody")}
          action={
            <Button asChild size="sm" variant="secondary">
              <Link href="/agents/connect">{t("empty.connect")}</Link>
            </Button>
          }
        />
      }
    >
      {(data) => (
        <div className="space-y-4" data-testid="cost-forecast-panel">
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard
              title={t("forecast.projected30d")}
              value={
                data.predicted_cost_usd != null
                  ? fmtUsd(data.predicted_cost_usd, { compact: true })
                  : data.overviewNext30d != null
                    ? fmtUsd(data.overviewNext30d, { compact: true })
                    : "—"
              }
              icon={Wallet}
              href={budgetHref}
            />
            <StatCard
              title={t("forecast.projected7d")}
              value={
                data.overviewNext7d != null
                  ? fmtUsd(data.overviewNext7d, { compact: true })
                  : "—"
              }
              icon={Sparkles}
              href={advisorHref}
            />
            <StatCard
              title={t("forecast.confidence")}
              value={
                data.confidence != null
                  ? `${(data.confidence * 100).toFixed(0)}%`
                  : "—"
              }
              icon={Sparkles}
              href={budgetHref}
            />
          </div>

          <Panel tone="inset" padding="md">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">{t("forecast.chartTitle")}</h3>
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" variant="secondary">
                  <Link href={budgetHref}>{t("forecast.openBudget")}</Link>
                </Button>
                <Button asChild size="sm" variant="ghost">
                  <Link href={advisorHref}>{t("forecast.openAdvisor")}</Link>
                </Button>
              </div>
            </div>
            {data.message ? (
              <p className="mb-2 text-xs text-[var(--text-muted)]">
                {data.message}
              </p>
            ) : null}
            {data.predictions.length > 0 ? (
              <ForecastLine data={data.predictions} />
            ) : (
              <p className="text-sm text-[var(--text-muted)]">
                {t("forecast.noSeries")}
              </p>
            )}
          </Panel>
        </div>
      )}
    </QueryState>
  );
}
