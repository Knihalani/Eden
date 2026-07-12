"use client";

import { useEffect, useState } from "react";
import { Loader2, Sparkles, Activity, TrendingUp } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { StatCard } from "@/components/ui/stat-card";
import { PageHeader } from "@/components/layout/page-header";
import { useOrg } from "@/hooks/use-org";
import { predictiveApi } from "@/lib/api";
import { NoOrgState } from "@/components/ui/no-org-state";
import { errorFromCaught } from "@/lib/safe-error-message";

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

/* ----------------------- Quality & Cost tabs ------------------------- */

function QualityTab() {
  const { currentOrg } = useOrg();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [data, setData] = useState<Array<{ date: string; median: number; ci_95_low: number; ci_95_high: number }>>([]);

  useEffect(() => {
    if (!currentOrg) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setError("");
    });
    predictiveApi
      .quality(currentOrg.id, { horizon_days: 7 })
      .then((res: {
        predictions?: Array<{ date: string; median: number; ci_95_low: number; ci_95_high: number }>;
        data?: { predictions?: Array<{ date: string; median: number; ci_95_low: number; ci_95_high: number }> };
      }) => {
        if (cancelled) return;
        setData(res.data?.predictions ?? res.predictions ?? []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(errorFromCaught(e, "Failed to load quality forecast"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentOrg]);

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center" role="status" aria-live="polite">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }
  if (error) {
    return <ErrorState title="Could not load quality forecast" message={error} />;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Quality forecast</CardTitle>
        <CardDescription>7-day judge score projection with 95% CI</CardDescription>
      </CardHeader>
      <CardContent>
        <ForecastLine data={data} />
      </CardContent>
    </Card>
  );
}

function DriftTab() {
  const { currentOrg } = useOrg();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [judgeDrift, setJudgeDrift] = useState<{
    drift_detected: boolean;
    drift_score: number;
    baseline_period: string;
    current_period: string;
    severity: string;
    top_shifts: Array<Record<string, unknown>>;
  } | null>(null);

  useEffect(() => {
    if (!currentOrg) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setError("");
    });
    // LP-12: embeddingDrift returns 501 — judge drift only.
    predictiveApi
      .drift(currentOrg.id)
      .then((jd: {
        drift_detected: boolean;
        drift_score: number;
        baseline_period: string;
        current_period: string;
        severity: string;
        top_shifts: Array<Record<string, unknown>>;
      }) => {
        if (cancelled) return;
        setJudgeDrift(jd);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(errorFromCaught(e, "Failed to load drift"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentOrg]);

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }
  if (error) {
    return <ErrorState title="Could not load drift" message={error} />;
  }

  return (
    <div className="space-y-4">
      <StatCard
        title="Judge-score drift"
        value={judgeDrift?.drift_score?.toFixed(3) ?? "0.000"}
        subtitle={judgeDrift?.drift_detected ? `Detected · ${judgeDrift.severity}` : "No drift detected"}
        icon={Activity}
        accent={judgeDrift?.drift_detected ? "warning" : "accent"}
      />
      <Card>
        <CardHeader>
          <CardTitle>Top judge-score shifts</CardTitle>
          <CardDescription>
            {judgeDrift
              ? `${judgeDrift.baseline_period} → ${judgeDrift.current_period}`
              : "Baseline → current"}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <DataTable
            columns={[
              {
                key: "field",
                header: "Field",
                cell: (s) => (
                  <span className="font-mono text-xs text-[var(--text-secondary)]">
                    {String((s as { key?: string; field?: string }).key ?? (s as { field?: string }).field ?? "shift")}
                  </span>
                ) },
              {
                key: "delta",
                header: "Δ",
                align: "right",
                cell: (s) =>
                  formatNumber(
                    ((s as { delta?: number; shift?: number; value?: number }).delta ??
                      (s as { shift?: number }).shift ??
                      (s as { value?: number }).value ??
                      0) as number
                  ),
                sortable: true },
            ]}
            rows={judgeDrift?.top_shifts ?? []}
            rowKey={(_, i) => `shift_${i}`}
            emptyIcon={Sparkles}
            emptyTitle="No top shifts"
            defaultSort={{ key: "delta", direction: "desc" }}
          />
        </CardContent>
      </Card>
    </div>
  );
}


/* ----------------------- Page ---------------------------------------- */

// LP-12: cost/capacity/risk return 501 deferred envelopes — hide those tabs.
type Tab = "quality" | "drift";

export default function PredictPage() {
  const { currentOrg } = useOrg();
  const [tab, setTab] = useState<Tab>("quality");

  if (!currentOrg) {
    return <NoOrgState feature="Predictions" />;
  }

  return (
    <div className="space-y-4">
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
        </TabsList>

        <AnimatePresence mode="wait">
          {tab === "quality" && (
            <TabsContent value="quality">
              <motion.div
                key="quality"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
              >
                {tab === "quality" && <QualityTab />}
              </motion.div>
            </TabsContent>
          )}
          {tab === "drift" && (
            <TabsContent value="drift">
              <motion.div
                key="drift"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
              >
                {tab === "drift" && <DriftTab />}
              </motion.div>
            </TabsContent>
          )}
        </AnimatePresence>
      </Tabs>
    </div>
  );
}
