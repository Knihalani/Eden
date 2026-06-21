"use client";

import { useEffect, useState } from "react";
import {
  Loader2,
  AlertTriangle,
  Sparkles,
  ShieldAlert,
  Activity,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { useOrg } from "@/hooks/use-org";
import { predictiveApi } from "@/lib/api";
import { cn } from "@/lib/utils";

/* ----------------------- Helpers -------------------------------------- */

function formatNumber(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function formatCurrency(n: number, opts?: { compact?: boolean }) {
  if (opts?.compact) {
    if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
    return `$${n.toFixed(2)}`;
  }
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/* ----------------------- Inline SVG forecast chart ------------------- */

function ForecastLine({
  data,
  unit = "value",
  height = 220,
  color = "var(--accent)",
}: {
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
      .then((res: { predictions?: Array<{ date: string; median: number; ci_95_low: number; ci_95_high: number }> }) => {
        if (cancelled) return;
        setData(res.predictions ?? []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load quality forecast");
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
    return <EmptyState icon={AlertTriangle} title="Could not load quality forecast" description={error} size="md" />;
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

function CostTab() {
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
      .cost(currentOrg.id, { horizon_days: 7 })
      .then((res: { predictions?: Array<{ date: string; median: number; ci_95_low: number; ci_95_high: number }> }) => {
        if (cancelled) return;
        setData(res.predictions ?? []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load cost forecast");
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
    return <EmptyState icon={AlertTriangle} title="Could not load cost forecast" description={error} size="md" />;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cost forecast</CardTitle>
        <CardDescription>7-day projected spend with 95% CI</CardDescription>
      </CardHeader>
      <CardContent>
        <ForecastLine data={data} unit="usd" color="var(--terminal)" />
      </CardContent>
    </Card>
  );
}

/* ----------------------- Capacity tab -------------------------------- */

function CapacityTab() {
  const { currentOrg } = useOrg();
  const [growth, setGrowth] = useState<number>(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [predictions, setPredictions] = useState<Array<{ date: string; gpu_hours: number }>>([]);
  const [scenarios, setScenarios] = useState<Record<string, { gpu_hours: number; cost: number }>>({});

  useEffect(() => {
    if (!currentOrg) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setError("");
    });
    predictiveApi
      .capacity(currentOrg.id, { horizon_days: 7 })
      .then((res: { predictions?: Array<{ date: string; gpu_hours: number }>; scenarios?: Record<string, { gpu_hours: number; cost: number }> }) => {
        if (cancelled) return;
        setPredictions(res.predictions ?? []);
        // The API returns scenarios; we add a custom "growth" derived scenario.
        const baseScenarios = res.scenarios ?? {};
        setScenarios({
          ...baseScenarios,
          [`growth_${growth}pct`]: scaleScenario(baseScenarios, growth / 100),
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load capacity");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentOrg, growth]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle>Capacity scenarios</CardTitle>
            <CardDescription>GPU-hour projections under different growth assumptions</CardDescription>
          </div>
          <label className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
            <span>Growth %</span>
            <input
              type="number"
              value={growth}
              onChange={(e) => setGrowth(Math.max(0, Math.min(500, Number(e.target.value) || 0)))}
              className="w-20 rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-2 py-1 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
          </div>
        ) : error ? (
          <EmptyState icon={AlertTriangle} title="Could not load capacity" description={error} size="md" />
        ) : (
          <>
            <DataTable
              columns={[
                { key: "name", header: "Scenario", cell: (r) => <span className="font-medium text-[var(--text-primary)]">{r.name}</span> },
                { key: "gpu_hours", header: "GPU hours", align: "right", cell: (r) => formatNumber(r.s.gpu_hours), sortable: true },
                { key: "cost", header: "Cost", align: "right", cell: (r) => formatCurrency(r.s.cost, { compact: true }), sortable: true },
              ]}
              rows={Object.entries(scenarios).map(([name, s]) => ({ name, s }))}
              rowKey={(r) => r.name}
              emptyTitle="No capacity scenarios"
            />
            {predictions.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                  Daily GPU hours (next {predictions.length} days)
                </p>
                <ForecastLine
                  data={predictions.map((p) => ({
                    date: p.date,
                    median: p.gpu_hours,
                    ci_95_low: p.gpu_hours * 0.9,
                    ci_95_high: p.gpu_hours * 1.1,
                  }))}
                  color="var(--terminal)"
                />
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function scaleScenario(
  base: Record<string, { gpu_hours: number; cost: number }>,
  factor: number
): { gpu_hours: number; cost: number } {
  // Compute a "total" of all known scenarios to extrapolate a growth scenario.
  let totalGpu = 0;
  let totalCost = 0;
  let n = 0;
  for (const v of Object.values(base)) {
    totalGpu += v.gpu_hours;
    totalCost += v.cost;
    n += 1;
  }
  const avgGpu = n > 0 ? totalGpu / n : 0;
  const avgCost = n > 0 ? totalCost / n : 0;
  return { gpu_hours: avgGpu * (1 + factor), cost: avgCost * (1 + factor) };
}

/* ----------------------- Drift tab ----------------------------------- */

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
  const [embedDrift, setEmbedDrift] = useState<{
    drift_detected: boolean;
    psi: number;
    histogram_buckets: number;
    severity: string;
  } | null>(null);

  useEffect(() => {
    if (!currentOrg) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setError("");
    });
    Promise.all([predictiveApi.drift(currentOrg.id), predictiveApi.embeddingDrift(currentOrg.id)])
      .then(([jd, ed]: [
        { drift_detected: boolean; drift_score: number; baseline_period: string; current_period: string; severity: string; top_shifts: Array<Record<string, unknown>> },
        { drift_detected: boolean; psi: number; histogram_buckets: number; severity: string }
      ]) => {
        if (cancelled) return;
        setJudgeDrift(jd);
        setEmbedDrift(ed);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load drift");
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
    return <EmptyState icon={AlertTriangle} title="Could not load drift" description={error} size="md" />;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatCard
          title="Judge-score drift"
          value={judgeDrift?.drift_score?.toFixed(3) ?? "0.000"}
          subtitle={judgeDrift?.drift_detected ? `Detected · ${judgeDrift.severity}` : "No drift detected"}
          icon={Activity}
          accent={judgeDrift?.drift_detected ? "warning" : "accent"}
        />
        <StatCard
          title="Embedding drift (PSI)"
          value={embedDrift?.psi?.toFixed(3) ?? "0.000"}
          subtitle={
            embedDrift?.drift_detected
              ? `Detected · ${embedDrift.severity} · ${embedDrift.histogram_buckets} buckets`
              : "No drift detected"
          }
          icon={Activity}
          accent={embedDrift?.drift_detected ? "warning" : "accent"}
        />
      </div>
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
                ),
              },
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
                sortable: true,
              },
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

/* ----------------------- Risk tab ------------------------------------ */

function RiskTab() {
  const { currentOrg } = useOrg();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [risk, setRisk] = useState<{
    risk_score: number;
    breakdown: Array<{ component: string; score: number; alerts: string[] }>;
  } | null>(null);

  useEffect(() => {
    if (!currentOrg) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setError("");
    });
    predictiveApi
      .risk(currentOrg.id)
      .then((res: { risk_score?: number; breakdown?: Array<{ component: string; score: number; alerts: string[] }> }) => {
        if (cancelled) return;
        setRisk({
          risk_score: res.risk_score ?? 0,
          breakdown: res.breakdown ?? [],
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load risk");
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
    return <EmptyState icon={AlertTriangle} title="Could not load risk" description={error} size="md" />;
  }

  const riskScore = risk?.risk_score ?? 0;
  const riskColor =
    riskScore >= 70
      ? "text-[var(--error)]"
      : riskScore >= 40
        ? "text-[var(--warning)]"
        : "text-[var(--success)]";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Composite risk</CardTitle>
          <CardDescription>Weighted score across 5 components (0-100)</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline gap-3">
            <span className={cn("text-6xl font-bold tracking-tight", riskColor)}>
              {riskScore.toFixed(0)}
            </span>
            <span className="text-sm text-[var(--text-muted)]">/ 100</span>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Component breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          {risk && risk.breakdown.length > 0 ? (
            <div className="space-y-3">
              {risk.breakdown.map((b) => (
                <div key={b.component}>
                  <div className="mb-1 flex items-center justify-between text-xs text-[var(--text-secondary)]">
                    <span className="font-medium capitalize">
                      {b.component.replace(/_/g, " ")}
                    </span>
                    <span className="text-[var(--text-muted)]">
                      {b.score.toFixed(0)}{b.alerts.length > 0 ? ` · ${b.alerts.length} alert${b.alerts.length === 1 ? "" : "s"}` : ""}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        b.score >= 70
                          ? "bg-[var(--error)]"
                          : b.score >= 40
                            ? "bg-[var(--warning)]"
                            : "bg-[var(--accent)]"
                      )}
                      style={{ width: `${Math.max(0, Math.min(100, b.score))}%` }}
                    />
                  </div>
                  {b.alerts.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-[10px] text-[var(--text-muted)]">
                      {b.alerts.map((a, i) => (
                        <li key={i}>• {a}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={ShieldAlert} title="No risk components" size="sm" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ----------------------- Page ---------------------------------------- */

type Tab = "quality" | "cost" | "capacity" | "drift" | "risk";

export default function PredictPage() {
  const { currentOrg } = useOrg();
  const [tab, setTab] = useState<Tab>("quality");

  if (!currentOrg) {
    return (
      <div className="rounded-lg border border-[var(--border-subtle)] p-8 text-center text-sm text-[var(--text-muted)]">
        Select an organization to view predictions.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList variant="underline" className="w-full overflow-x-auto">
          <TabsTrigger value="quality" variant="underline">
            Quality
          </TabsTrigger>
          <TabsTrigger value="cost" variant="underline">
            Cost
          </TabsTrigger>
          <TabsTrigger value="capacity" variant="underline">
            Capacity
          </TabsTrigger>
          <TabsTrigger value="drift" variant="underline">
            Drift
          </TabsTrigger>
          <TabsTrigger value="risk" variant="underline">
            Risk
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
          {tab === "cost" && (
            <TabsContent value="cost">
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
          {tab === "capacity" && (
            <TabsContent value="capacity">
              <motion.div
                key="capacity"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
              >
                {tab === "capacity" && <CapacityTab />}
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
          {tab === "risk" && (
            <TabsContent value="risk">
              <motion.div
                key="risk"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
              >
                {tab === "risk" && <RiskTab />}
              </motion.div>
            </TabsContent>
          )}
        </AnimatePresence>
      </Tabs>
    </div>
  );
}
