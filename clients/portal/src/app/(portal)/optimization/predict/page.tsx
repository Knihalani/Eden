"use client";

import { useState } from "react";
import { Sparkles, Activity, TrendingUp, Wallet, Server, ShieldAlert } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { StatCard } from "@/components/ui/stat-card";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent, PageLoadingSkeleton } from "@/components/layout/page-content";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { predictiveApi } from "@/lib/api";
import {
  assertOkEnvelope,
  featureGatedErrorCopy,
  isRetryableIntelligenceError,
} from "@/lib/feature-flag-error";
import { NoOrgState } from "@/components/ui/no-org-state";

function RetryAction({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  if (!isRetryableIntelligenceError(error)) return null;
  return (
    <button
      onClick={onRetry}
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-[var(--accent)] text-[var(--bg-base)] text-xs font-medium hover:bg-[var(--accent-hover)] transition-colors"
    >
      Try again
    </button>
  );
}

/* ----------------------- Helpers -------------------------------------- */

function formatNumber(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function formatCurrency(n: number, opts?: { compact?: boolean }) {
  if (opts?.compact && Math.abs(n) >= 1000) {
    return `$${(n / 1000).toFixed(1)}k`;
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
}

/* ----------------------- Inline SVG forecast chart ------------------- */

function ForecastLine({
  data,
  unit = "value",
  height = 220,
  color = "var(--accent)" }: {
  data: Array<{ date: string; median: number; ci_95_low: number; ci_95_high: number }>;
  unit?: "value" | "usd";
  height?: number;
  color?: string;
}) {
  if (data.length === 0) {
    return (
      <EmptyState icon={Sparkles} title="No forecast data" size="sm" />
    );
  }
  const width = 720;
  const padX = 40;
  const padY = 24;
  const xs = data.map((d) => new Date(d.date).getTime());
  const ys = data.flatMap((d) => [d.ci_95_low, d.ci_95_high, d.median]);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const yRange = Math.max(1e-9, yMax - yMin);
  const xRange = Math.max(1, xMax - xMin);
  const xScale = (t: number) => padX + ((t - xMin) / xRange) * (width - padX * 2);
  const yScale = (v: number) => height - padY - ((v - yMin) / yRange) * (height - padY * 2);

  const linePath = data
    .map((d, i) => {
      const x = xScale(new Date(d.date).getTime());
      const y = yScale(d.median);
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
    const bottom = data
      .slice()
      .reverse()
      .map((d) => {
        const x = xScale(new Date(d.date).getTime());
        const y = yScale(d.ci_95_low);
        return `L ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
    return `${top} ${bottom} Z`;
  })();

  const formatTick = (v: number) => (unit === "usd" ? formatCurrency(v, { compact: true }) : formatNumber(v));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }} role="img" aria-label="Forecast">
      <defs>
        <linearGradient id={`band-${color.replace(/[^a-z0-9]/gi, "")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
      </defs>
      <line x1={padX} y1={height - padY} x2={width - padX} y2={height - padY} stroke="var(--border-subtle)" />
      <line x1={padX} y1={padY} x2={padX} y2={height - padY} stroke="var(--border-subtle)" />
      <path d={bandPath} fill={`url(#band-${color.replace(/[^a-z0-9]/gi, "")})`} stroke="none" />
      <path d={linePath} fill="none" stroke={color} strokeWidth={2} />
      {data.map((d) => {
        const x = xScale(new Date(d.date).getTime());
        const y = yScale(d.median);
        return <circle key={d.date} cx={x} cy={y} r={2.5} fill={color} />;
      })}
      <text x={padX - 6} y={padY + 4} textAnchor="end" fontSize={10} fill="var(--text-muted)">
        {formatTick(yMax)}
      </text>
      <text x={padX - 6} y={height - padY} textAnchor="end" fontSize={10} fill="var(--text-muted)">
        {formatTick(yMin)}
      </text>
      <text x={padX} y={height - 6} textAnchor="start" fontSize={10} fill="var(--text-muted)">
        {data[0].date.slice(5)}
      </text>
      <text x={width - padX} y={height - 6} textAnchor="end" fontSize={10} fill="var(--text-muted)">
        {data[data.length - 1].date.slice(5)}
      </text>
    </svg>
  );
}

/* ----------------------- Quality & Drift tabs ------------------------- */

function QualityTab() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const { data, isLoading, error, refetch } = useOrgQuery(
    queryKeys.predict.quality(orgId, { horizon_days: 7 }),
    orgId,
    async () => {
      const res = await predictiveApi.quality(orgId!, { horizon_days: 7 });
      const payload = assertOkEnvelope(res, "Could not load quality forecast");
      const points = payload.predictions ?? [];
      // BE field is ``predicted_score_median``; chart expects ``median``.
      return points.map((p) => ({
        date: p.date,
        median: p.predicted_score_median,
        ci_95_low: p.ci_95_low,
        ci_95_high: p.ci_95_high,
      }));
    },
  );

  if (isLoading) {
    return <PageLoadingSkeleton variant="default" lines={4} />;
  }
  if (error) {
    const copy = featureGatedErrorCopy(error, "Could not load quality forecast");
    return (
      <ErrorState
        title={copy.title}
        message={copy.message}
        action={<RetryAction error={error} onRetry={() => refetch()} />}
      />
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Quality forecast</CardTitle>
        <CardDescription>7-day judge score projection with 95% CI</CardDescription>
      </CardHeader>
      <CardContent>
        <ForecastLine data={data ?? []} />
      </CardContent>
    </Card>
  );
}

function DriftTab() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const { data: drift, isLoading, error, refetch } = useOrgQuery(
    queryKeys.predict.drift(orgId),
    orgId,
    async () => {
      const res = await predictiveApi.drift(orgId!);
      return assertOkEnvelope(res, "Could not load drift");
    },
  );

  if (isLoading) {
    return <PageLoadingSkeleton variant="default" lines={4} />;
  }
  if (error) {
    const copy = featureGatedErrorCopy(error, "Could not load drift");
    return (
      <ErrorState
        title={copy.title}
        message={copy.message}
        action={<RetryAction error={error} onRetry={() => refetch()} />}
      />
    );
  }

  const details = drift?.details ?? {};
  const detailRows = [
    { key: "baseline_window", label: "Baseline window", value: String(details.baseline_window ?? "—") },
    { key: "current_window", label: "Current window", value: String(details.current_window ?? "—") },
    { key: "baseline_samples", label: "Baseline samples", value: formatNumber(Number(details.baseline_samples ?? 0)) },
    { key: "current_samples", label: "Current samples", value: formatNumber(Number(details.current_samples ?? 0)) },
    { key: "buckets", label: "PSI buckets", value: formatNumber(Number(details.buckets ?? 0)) },
  ];
  const drifted = drift?.severity === "warning" || drift?.severity === "high";

  return (
    <div className="space-y-4">
      <StatCard
        title="Output drift (PSI)"
        value={drift?.psi_value != null ? drift.psi_value.toFixed(3) : "—"}
        subtitle={drifted ? `Detected · ${drift?.severity}` : `No shift · ${drift?.severity ?? "—"}`}
        icon={Activity}
        accent={drifted ? "warning" : "accent"}
      />
      <Card>
        <CardHeader>
          <CardTitle>Drift details</CardTitle>
          <CardDescription>
            {details.baseline_window && details.current_window
              ? `${details.baseline_window} → ${details.current_window}`
              : "Baseline → current"}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <DataTable
            columns={[
              {
                key: "label",
                header: "Field",
                cell: (s) => (
                  <span className="font-mono text-xs text-[var(--text-secondary)]">
                    {s.label}
                  </span>
                ),
              },
              {
                key: "value",
                header: "Value",
                align: "right",
                cell: (s) => s.value,
              },
            ]}
            rows={detailRows}
            rowKey={(r) => r.key}
            emptyIcon={Sparkles}
            emptyTitle="No drift details"
          />
        </CardContent>
      </Card>
    </div>
  );
}

/* ----------------------- Thin cost / capacity / risk tabs ------------ */

function CostTab() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const { data, isLoading, error, refetch } = useOrgQuery(
    queryKeys.predict.cost(orgId, { horizon_days: 30 }),
    orgId,
    async () => {
      const res = await predictiveApi.cost(orgId!, { horizon_days: 30 });
      const payload = assertOkEnvelope(res, "Could not load cost forecast");
      const points = (payload.predictions ?? []).map((p) => ({
        date: p.date,
        median: p.predicted_cost_usd,
        ci_95_low: p.ci_95_low,
        ci_95_high: p.ci_95_high,
      }));
      return {
        headline: payload.predicted_cost_usd ?? null,
        confidence: payload.confidence ?? null,
        points,
      };
    },
  );

  if (isLoading) return <PageLoadingSkeleton variant="default" lines={4} />;
  if (error) {
    const copy = featureGatedErrorCopy(error, "Could not load cost forecast");
    return (
      <ErrorState
        title={copy.title}
        message={copy.message}
        action={<RetryAction error={error} onRetry={() => refetch()} />}
      />
    );
  }

  return (
    <div className="space-y-4">
      <StatCard
        title="Predicted daily cost"
        value={data?.headline != null ? formatCurrency(data.headline) : "—"}
        subtitle={data?.confidence != null ? `Confidence ${formatNumber(data.confidence)}` : "Median projection"}
        icon={Wallet}
        accent="warning"
      />
      <Card>
        <CardHeader>
          <CardTitle>Cost forecast</CardTitle>
          <CardDescription>30-day cost projection with 95% CI</CardDescription>
        </CardHeader>
        <CardContent>
          <ForecastLine data={data?.points ?? []} unit="usd" color="var(--warning)" />
        </CardContent>
      </Card>
    </div>
  );
}

function CapacityTab() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const { data, isLoading, error, refetch } = useOrgQuery(
    queryKeys.predict.capacity(orgId, { horizon_days: 7 }),
    orgId,
    async () => {
      const res = await predictiveApi.capacity(orgId!, { horizon_days: 7 });
      return assertOkEnvelope(res, "Could not load capacity forecast");
    },
  );

  if (isLoading) return <PageLoadingSkeleton variant="default" lines={3} />;
  if (error) {
    const copy = featureGatedErrorCopy(error, "Could not load capacity forecast");
    return (
      <ErrorState
        title={copy.title}
        message={copy.message}
        action={<RetryAction error={error} onRetry={() => refetch()} />}
      />
    );
  }

  return (
    <div className="space-y-4">
      <StatCard
        title="Total GPU hours"
        value={data?.total_gpu_hours != null ? formatNumber(data.total_gpu_hours) : "—"}
        subtitle={data?.recommendation ?? `Scenario · ${data?.scenario ?? "baseline"}`}
        icon={Server}
        accent="accent"
      />
    </div>
  );
}

function RiskTab() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const { data, isLoading, error, refetch } = useOrgQuery(
    queryKeys.predict.risk(orgId),
    orgId,
    async () => {
      const res = await predictiveApi.risk(orgId!);
      return assertOkEnvelope(res, "Could not load risk score");
    },
  );

  if (isLoading) return <PageLoadingSkeleton variant="default" lines={3} />;
  if (error) {
    const copy = featureGatedErrorCopy(error, "Could not load risk score");
    return (
      <ErrorState
        title={copy.title}
        message={copy.message}
        action={<RetryAction error={error} onRetry={() => refetch()} />}
      />
    );
  }

  const score = data?.composite_risk_score;
  const breakdown = Object.entries(data?.risk_breakdown ?? {}).map(([key, value]) => ({
    key,
    value: value == null ? "—" : formatNumber(value),
  }));

  return (
    <div className="space-y-4">
      <StatCard
        title="Composite risk"
        value={score != null ? formatNumber(score) : "—"}
        subtitle={data?.recommendation ?? "Weighted risk score"}
        icon={ShieldAlert}
        accent={score != null && score >= 0.5 ? "warning" : "accent"}
      />
      <Card>
        <CardHeader>
          <CardTitle>Risk breakdown</CardTitle>
          <CardDescription>Per-component scores</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <DataTable
            columns={[
              {
                key: "key",
                header: "Component",
                cell: (r) => (
                  <span className="font-mono text-xs text-[var(--text-secondary)]">{r.key}</span>
                ),
              },
              { key: "value", header: "Score", align: "right", cell: (r) => r.value },
            ]}
            rows={breakdown}
            rowKey={(r) => r.key}
            emptyIcon={Sparkles}
            emptyTitle="No risk components"
          />
        </CardContent>
      </Card>
    </div>
  );
}

/* ----------------------- Page ---------------------------------------- */

// Cost / capacity / risk are live Cat 13 routes (envelope under ``data``).
type Tab = "quality" | "drift" | "cost" | "capacity" | "risk";

export default function PredictPage() {
  const { currentOrg } = useOrg();
  const [tab, setTab] = useState<Tab>("quality");

  if (!currentOrg) {
    return <NoOrgState feature="Predictions" />;
  }

  return (
    <PageContent>
      <PageHeader
        eyebrow="Predict"
        title="Quality forecast & drift"
        subtitle="Judge-score projections with 95% confidence bands and output drift detection."
        icon={TrendingUp}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList variant="underline" className="w-full overflow-x-auto">
          <TabsTrigger value="quality" variant="underline">
            Quality
          </TabsTrigger>
          <TabsTrigger value="drift" variant="underline">
            Drift
          </TabsTrigger>
          <TabsTrigger value="cost" variant="underline">
            Cost
          </TabsTrigger>
          <TabsTrigger value="capacity" variant="underline">
            Capacity
          </TabsTrigger>
          <TabsTrigger value="risk" variant="underline">
            Risk
          </TabsTrigger>
        </TabsList>

        <>
          {tab === "quality" && (
            <TabsContent value="quality">
              <div key="quality">
                {tab === "quality" && <QualityTab />}
              </div>
            </TabsContent>
          )}
          {tab === "drift" && (
            <TabsContent value="drift">
              <div key="drift">
                {tab === "drift" && <DriftTab />}
              </div>
            </TabsContent>
          )}
          {tab === "cost" && (
            <TabsContent value="cost">
              <div key="cost">
                {tab === "cost" && <CostTab />}
              </div>
            </TabsContent>
          )}
          {tab === "capacity" && (
            <TabsContent value="capacity">
              <div key="capacity">
                {tab === "capacity" && <CapacityTab />}
              </div>
            </TabsContent>
          )}
          {tab === "risk" && (
            <TabsContent value="risk">
              <div key="risk">
                {tab === "risk" && <RiskTab />}
              </div>
            </TabsContent>
          )}
        </>
      </Tabs>
    </PageContent>
  );
}
