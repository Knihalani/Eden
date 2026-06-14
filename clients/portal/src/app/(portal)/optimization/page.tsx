"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Loader2, TrendingUp, TrendingDown, AlertTriangle, Sparkles, Target, BarChart3 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { useOrg } from "@/hooks/use-org";
import { costApi } from "@/lib/api";
import { cn } from "@/lib/utils";

/* ----------------------- Sub-pages (lazy) ----------------------------- */

const OutcomesPage = dynamic(() => import("./outcomes/page"), { ssr: false });
const PredictPage = dynamic(() => import("./predict/page"), { ssr: false });

/* ----------------------- Inline SVG forecast chart -------------------- */

function ForecastChart({
  data,
}: {
  data: Array<{ date: string; projected_cost: number; ci_low: number; ci_high: number }>;
}) {
  if (data.length === 0) {
    return (
      <EmptyState
        icon={Sparkles}
        title="No forecast data"
        description="Forecast appears once you have usage history."
        size="md"
      />
    );
  }
  const width = 720;
  const height = 240;
  const padX = 40;
  const padY = 24;
  const xs = data.map((d) => new Date(d.date).getTime());
  const ys = data.flatMap((d) => [d.ci_low, d.ci_high, d.projected_cost]);
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
      const y = yScale(d.projected_cost);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  const bandPath = (() => {
    const top = data.map((d, i) => {
      const x = xScale(new Date(d.date).getTime());
      const y = yScale(d.ci_high);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    });
    const bottom = data
      .slice()
      .reverse()
      .map((d) => {
        const x = xScale(new Date(d.date).getTime());
        const y = yScale(d.ci_low);
        return `L ${x.toFixed(1)} ${y.toFixed(1)}`;
      });
    return [...top, ...bottom, "Z"].join(" ");
  })();

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-64 w-full"
      role="img"
      aria-label="Projected cost forecast"
    >
      <defs>
        <linearGradient id="fcBand" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.25} />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
        </linearGradient>
      </defs>
      {/* axes */}
      <line
        x1={padX}
        y1={height - padY}
        x2={width - padX}
        y2={height - padY}
        stroke="var(--border-subtle)"
      />
      <line
        x1={padX}
        y1={padY}
        x2={padX}
        y2={height - padY}
        stroke="var(--border-subtle)"
      />
      {/* CI band */}
      <path d={bandPath} fill="url(#fcBand)" stroke="none" />
      {/* projected line */}
      <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth={2} />
      {/* dots */}
      {data.map((d) => {
        const x = xScale(new Date(d.date).getTime());
        const y = yScale(d.projected_cost);
        return <circle key={d.date} cx={x} cy={y} r={2.5} fill="var(--accent)" />;
      })}
      {/* y axis labels */}
      <text
        x={padX - 6}
        y={padY + 4}
        textAnchor="end"
        fontSize={10}
        fill="var(--text-muted)"
      >
        {`$${yMax.toFixed(0)}`}
      </text>
      <text
        x={padX - 6}
        y={height - padY}
        textAnchor="end"
        fontSize={10}
        fill="var(--text-muted)"
      >
        {`$${yMin.toFixed(0)}`}
      </text>
      {/* x axis labels (first + last) */}
      <text
        x={padX}
        y={height - 6}
        textAnchor="start"
        fontSize={10}
        fill="var(--text-muted)"
      >
        {data[0].date.slice(5)}
      </text>
      <text
        x={width - padX}
        y={height - 6}
        textAnchor="end"
        fontSize={10}
        fill="var(--text-muted)"
      >
        {data[data.length - 1].date.slice(5)}
      </text>
    </svg>
  );
}

/* ----------------------- Helpers -------------------------------------- */

function formatCurrency(n: number, opts?: { compact?: boolean }) {
  if (opts?.compact) {
    if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
    return `$${n.toFixed(2)}`;
  }
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatNumber(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

/* ----------------------- Cost tab ------------------------------------- */

function CostTab() {
  const { currentOrg } = useOrg();
  const [days, setDays] = useState<number>(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  const [efficiency, setEfficiency] = useState<{
    efficiency_score: number;
    by_model: Array<{ model: string; cost_per_call: number; success_rate: number }>;
    period_days: number;
  } | null>(null);
  const [roi, setRoi] = useState<{
    total_cost: number;
    total_revenue: number;
    roi: number;
    per_agent: Array<{ agent_id: string; cost: number; revenue: number; roi: number }>;
  } | null>(null);
  const [forecast, setForecast] = useState<{
    forecast: Array<{ date: string; projected_cost: number; ci_low: number; ci_high: number }>;
    model: string;
    period_days: number;
  } | null>(null);
  const [anomalies, setAnomalies] = useState<{
    anomalies: Array<{ date: string; z_score: number; severity: string; agent_id: string; cost: number }>;
  } | null>(null);

  useEffect(() => {
    if (!currentOrg) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setError("");
    });
    Promise.all([
      costApi.efficiency(currentOrg.id, { days }).catch((e: unknown) => {
        throw e;
      }),
      costApi.roi(currentOrg.id, { days }),
      costApi.anomalies(currentOrg.id, { days }),
      costApi.forecast(currentOrg.id),
    ])
      .then(([eff, r, an, fc]) => {
        if (cancelled) return;
        setEfficiency(eff);
        setRoi(r);
        setAnomalies(an);
        setForecast(fc);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load cost data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentOrg, days]);

  if (!currentOrg) {
    return (
      <div className="rounded-lg border border-[var(--border-subtle)] p-8 text-center text-sm text-[var(--text-muted)]">
        Select an organization to view cost data.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Could not load cost data"
        description={error}
        size="md"
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Day range selector */}
      <div className="flex items-center justify-end">
        <div className="inline-flex rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-0.5 shadow-sm">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-all",
                days === d
                  ? "bg-[var(--accent)] text-[var(--bg-primary)] shadow-sm"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              )}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Efficiency score"
          value={efficiency ? efficiency.efficiency_score.toFixed(2) : "—"}
          subtitle={`${efficiency?.period_days ?? days}-day window`}
          icon={Target}
          accent="accent"
        />
        <StatCard
          title="Total cost"
          value={roi ? formatCurrency(roi.total_cost, { compact: true }) : "—"}
          subtitle={`${days}-day window`}
          icon={TrendingDown}
          accent="warning"
        />
        <StatCard
          title="Total revenue"
          value={roi ? formatCurrency(roi.total_revenue, { compact: true }) : "—"}
          subtitle="Tracked outcomes"
          icon={TrendingUp}
          accent="terminal"
        />
        <StatCard
          title="ROI"
          value={roi ? roi.roi.toFixed(2) : "—"}
          subtitle="Revenue / cost"
          icon={BarChart3}
          accent={(roi?.roi ?? 0) >= 1 ? "accent" : "warning"}
        />
      </div>

      {/* Forecast chart */}
      <Card>
        <CardHeader>
          <CardTitle>Projected cost</CardTitle>
          <CardDescription>
            {forecast
              ? `${forecast.forecast.length}-day horizon · model: ${forecast.model}`
              : "Forecast unavailable"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {forecast ? <ForecastChart data={forecast.forecast} /> : null}
        </CardContent>
      </Card>

      {/* ROI by agent table */}
      <Card>
        <CardHeader>
          <CardTitle>ROI by agent</CardTitle>
          <CardDescription>Cost vs revenue attributed per agent</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {roi && roi.per_agent.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">ROI</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {roi.per_agent.map((a) => (
                  <TableRow key={a.agent_id}>
                    <TableCell className="font-mono text-xs text-[var(--text-secondary)]">
                      {a.agent_id}
                    </TableCell>
                    <TableCell className="text-right text-[var(--text-primary)]">
                      {formatCurrency(a.cost, { compact: true })}
                    </TableCell>
                    <TableCell className="text-right text-[var(--text-primary)]">
                      {formatCurrency(a.revenue, { compact: true })}
                    </TableCell>
                    <TableCell className="text-right">
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
                          a.roi >= 2
                            ? "bg-[var(--success-bg)] text-[var(--success)]"
                            : a.roi >= 1
                              ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                              : "bg-[var(--error-bg)] text-[var(--error)]"
                        )}
                      >
                        {a.roi.toFixed(2)}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              icon={BarChart3}
              title="No ROI data"
              description="Track outcomes on traces to populate agent ROI."
              size="sm"
            />
          )}
        </CardContent>
      </Card>

      {/* Anomalies table */}
      <Card>
        <CardHeader>
          <CardTitle>Cost anomalies</CardTitle>
          <CardDescription>
            {anomalies ? `${anomalies.anomalies.length} detected` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {anomalies && anomalies.anomalies.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Z-score</TableHead>
                  <TableHead>Severity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {anomalies.anomalies.map((a, i) => (
                  <TableRow key={`${a.date}-${a.agent_id}-${i}`}>
                    <TableCell className="text-[var(--text-secondary)]">{a.date}</TableCell>
                    <TableCell className="font-mono text-xs text-[var(--text-secondary)]">
                      {a.agent_id}
                    </TableCell>
                    <TableCell className="text-right text-[var(--text-primary)]">
                      {formatCurrency(a.cost, { compact: true })}
                    </TableCell>
                    <TableCell className="text-right text-[var(--text-primary)]">
                      {formatNumber(a.z_score)}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                          a.severity === "high" || Math.abs(a.z_score) > 4
                            ? "bg-[var(--error-bg)] text-[var(--error)]"
                            : a.severity === "medium"
                              ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                              : "bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
                        )}
                      >
                        {a.severity}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              icon={Sparkles}
              title="No anomalies detected"
              description="All costs within expected z-score range."
              size="sm"
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ----------------------- Page ---------------------------------------- */

export default function OptimizationPage() {
  const { currentOrg } = useOrg();
  const [tab, setTab] = useState<"cost" | "outcomes" | "predict">("cost");

  if (!currentOrg) {
    return (
      <div className="p-8 text-center text-sm text-[var(--text-muted)]">
        Select an organization to view optimization data.
      </div>
    );
  }

  return (
    <div className="page-enter mx-auto max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)] sm:text-3xl">
          Cost & usage optimization
        </h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Where your tokens go, what caching saves, and how the budget is burning.
        </p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as "cost" | "outcomes" | "predict")}
      >
        <TabsList variant="underline" className="w-full">
          <TabsTrigger value="cost" variant="underline">Cost</TabsTrigger>
          <TabsTrigger value="outcomes" variant="underline">Outcomes</TabsTrigger>
          <TabsTrigger value="predict" variant="underline">Predict</TabsTrigger>
        </TabsList>

        <AnimatePresence mode="wait">
          {tab === "cost" && (
            <TabsContent value="cost" forceMount={tab === "cost" ? true : undefined}>
              <motion.div
                key="cost"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
              >
                {tab === "cost" && <CostTab />}
              </motion.div>
            </TabsContent>
          )}
          {tab === "outcomes" && (
            <TabsContent value="outcomes" forceMount={tab === "outcomes" ? true : undefined}>
              <motion.div
                key="outcomes"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
              >
                {tab === "outcomes" && <OutcomesPage />}
              </motion.div>
            </TabsContent>
          )}
          {tab === "predict" && (
            <TabsContent value="predict" forceMount={tab === "predict" ? true : undefined}>
              <motion.div
                key="predict"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
              >
                {tab === "predict" && <PredictPage />}
              </motion.div>
            </TabsContent>
          )}
        </AnimatePresence>
      </Tabs>
    </div>
  );
}
