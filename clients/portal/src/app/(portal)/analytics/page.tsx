"use client";

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertCircle,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  DollarSign,
  Zap,
  Users,
  Database,
  Sparkles,
  ChevronRight,
  BarChart,
  Layers,
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  Target,
  ShieldAlert,
  FileText,
  Plus,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart as ReBarChart,
  Bar,
  Cell,
  PieChart,
  Pie,
  Legend,
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
} from "recharts";
import { motion, AnimatePresence } from "framer-motion";

// ── Types ────────────────────────────────────────────────────────────────

interface KPIs {
  total_jobs: number;
  successful_jobs: number;
  failed_jobs: number;
  success_rate: number;
  avg_duration_ms: number;
  p95_duration_ms: number;
  median_duration_ms: number;
  gold_outcome_rate: number;
  test_pass_rate: number;
  avg_quality_score: number;
  adversarial_issues_found: number;
  total_cost_usd: number;
  avg_cost_per_job: number;
  total_tokens: number;
  avg_tokens_per_job: number;
  jobs_by_environment_class: Record<string, number>;
  jobs_by_framework: Record<string, number>;
  jobs_by_outcome_tier: Record<string, number>;
  cost_by_model: Record<string, number>;
  tokens_by_model: Record<string, number>;
  data_quality_score: number;
  pii_incidents: number;
  quarantine_rate: number;
}

interface TrendPoint {
  timestamp: string;
  value: number;
  count?: number;
}

interface TrendAnalysis {
  metric_name: string;
  period_days: number;
  current_value: number;
  previous_value: number;
  change_abs: number;
  change_pct: number;
  direction: string;
  moving_average_7d: number;
  moving_average_30d: number;
  forecast_next_7d: number | null;
  anomaly_dates: string[];
  data_points: TrendPoint[];
}

interface Cohort {
  cohort_label: string;
  total_members: number;
  active_members: number;
  activation_rate: number;
  retention_day_7: number;
  retention_day_30: number;
  avg_jobs_per_member: number;
  avg_quality_score: number;
  total_cost_usd: number;
}

interface BenchmarkComparison {
  metric_name: string;
  org_value: number;
  global_avg: number;
  global_p50: number;
  global_p90: number;
  percentile: number;
  gap_pct: number;
}

interface DatasetItem {
  dataset_id: string;
  name: string;
  dataset_type: string;
  version: string;
  entry_count: number;
  tags: string[];
  created_at: string;
  updated_at: string;
}

interface AggregateMetrics {
  period_days: number;
  jobs: {
    total: number;
    successful: number;
    success_rate: number;
    avg_quality: number;
    avg_duration_ms: number;
    p95_duration_ms: number;
  };
  costs: {
    total_cost_usd: number;
    total_tokens: number;
  };
  members: {
    total: number;
    active: number;
    activity_rate: number;
  };
  references: { total: number };
  daily_jobs: Array<{ date: string; count: number }>;
}

// ── Tab definitions ──────────────────────────────────────────────────────

type TabKey = "overview" | "trends" | "cohorts" | "benchmarks" | "datasets" | "synthetic";

const TABS: { key: TabKey; label: string; icon: typeof BarChart3 }[] = [
  { key: "overview", label: "Overview", icon: BarChart3 },
  { key: "trends", label: "Trends", icon: TrendingUp },
  { key: "cohorts", label: "Cohorts", icon: Users },
  { key: "benchmarks", label: "Benchmarks", icon: Target },
  { key: "datasets", label: "Datasets", icon: Database },
  { key: "synthetic", label: "Synthetic", icon: Sparkles },
];

// ── Component ────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? "";

  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [periodDays, setPeriodDays] = useState(30);
  const [kpis, setKpis] = useState<KPIs | null>(null);
  const [trends, setTrends] = useState<{
    jobs: TrendAnalysis | null;
    quality: TrendAnalysis | null;
    costs: TrendAnalysis | null;
  }>({ jobs: null, quality: null, costs: null });
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [benchmarks, setBenchmarks] = useState<BenchmarkComparison[]>([]);
  const [aggregate, setAggregate] = useState<AggregateMetrics | null>(null);
  const [datasets, setDatasets] = useState<DatasetItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchAll = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError("");
    try {
      const [kpiData, aggData, jobTrend, qualTrend, costTrend, cohortData, benchData, dsData] =
        await Promise.all([
          api.getLatestKPIs(orgId, periodDays).catch(() => null),
          api.getAggregateMetrics(orgId, periodDays).catch(() => null),
          api.getJobTrends(orgId, periodDays).catch(() => null),
          api.getQualityTrends(orgId, periodDays).catch(() => null),
          api.getCostTrends(orgId, periodDays).catch(() => null),
          api.getCohortAnalysis(orgId, periodDays).catch(() => null),
          api.getBenchmarkComparison(orgId, periodDays).catch(() => null),
          api.listTrainingDatasets(orgId).catch(() => null),
        ]);

      setKpis(kpiData);
      setAggregate(aggData);
      setTrends({ jobs: jobTrend, quality: qualTrend, costs: costTrend });
      setCohorts(cohortData?.cohorts || []);
      setBenchmarks(benchData?.comparisons || []);
      setDatasets(dsData?.datasets || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load analytics");
    } finally {
      setLoading(false);
    }
  }, [orgId, periodDays]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  if (!orgId) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <BarChart3 className="w-12 h-12 mx-auto text-[var(--text-muted)] mb-3" />
          <p className="text-[var(--text-secondary)]">Select an organization to view analytics</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 lg:px-6 py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Analytics</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            Gold-layer KPIs, trends, cohorts, and data intelligence
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PeriodSelector value={periodDays} onChange={setPeriodDays} />
          <button
            onClick={fetchAll}
            disabled={loading}
            className="p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
            title="Refresh"
          >
            <Loader2 className={cn("w-4 h-4", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-[var(--error-bg)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--error)]/20">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Tab navigation */}
      <div className="border-b border-[var(--border-default)]">
        <div className="flex gap-1 overflow-x-auto scrollbar-hide">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={cn(
                  "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
                  activeTab === tab.key
                    ? "border-[var(--accent)] text-[var(--accent)]"
                    : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                )}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.2 }}
        >
          {activeTab === "overview" && <OverviewTab kpis={kpis} aggregate={aggregate} />}
          {activeTab === "trends" && <TrendsTab trends={trends} />}
          {activeTab === "cohorts" && <CohortsTab cohorts={cohorts} />}
          {activeTab === "benchmarks" && <BenchmarksTab benchmarks={benchmarks} />}
          {activeTab === "datasets" && <DatasetsTab datasets={datasets} orgId={orgId} onRefresh={fetchAll} />}
          {activeTab === "synthetic" && <SyntheticTab datasets={datasets} orgId={orgId} onRefresh={fetchAll} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ── Period Selector ──────────────────────────────────────────────────────

function PeriodSelector({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const options = [
    { label: "7D", value: 7 },
    { label: "30D", value: 30 },
    { label: "90D", value: 90 },
  ];
  return (
    <div className="flex bg-[var(--bg-tertiary)] rounded-lg p-1">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            "px-3 py-1 text-xs font-medium rounded-md transition-colors",
            value === opt.value
              ? "bg-[var(--accent)] text-[var(--bg-base)]"
              : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ── Overview Tab ─────────────────────────────────────────────────────────

function OverviewTab({ kpis, aggregate }: { kpis: KPIs | null; aggregate: AggregateMetrics | null }) {
  if (!kpis && !aggregate) {
    return <EmptyState message="No overview data yet — generate an environment to see totals here." />;
  }

  const k = kpis;
  const a = aggregate;

  const cards = [
    {
      label: "Total Jobs",
      value: k?.total_jobs ?? a?.jobs.total ?? 0,
      icon: Layers,
      color: "text-[var(--accent)]",
      sub: `${k?.successful_jobs ?? 0} successful · ${k?.failed_jobs ?? 0} failed`,
    },
    {
      label: "Success Rate",
      value: `${k?.success_rate ?? a?.jobs.success_rate ?? 0}%`,
      icon: CheckCircle2,
      color: "text-[var(--success)]",
      sub: `Gold: ${k?.gold_outcome_rate ?? 0}%`,
    },
    {
      label: "Avg Quality",
      value: (k?.avg_quality_score ?? a?.jobs.avg_quality ?? 0).toFixed(2),
      icon: Target,
      color: "text-[var(--accent)]",
      sub: `Test pass: ${k?.test_pass_rate ?? 0}%`,
    },
    {
      label: "Total Cost",
      value: `$${(k?.total_cost_usd ?? a?.costs.total_cost_usd ?? 0).toFixed(2)}`,
      icon: DollarSign,
      color: "text-[var(--error)]",
      sub: `${(k?.total_tokens ?? a?.costs.total_tokens ?? 0).toLocaleString()} tokens`,
    },
    {
      label: "Data Quality",
      value: `${((k?.data_quality_score ?? 1) * 100).toFixed(0)}%`,
      icon: ShieldAlert,
      color: "text-[var(--warning)]",
      sub: `${k?.pii_incidents ?? 0} PII incidents`,
    },
    {
      label: "Active Members",
      value: a?.members.active ?? 0,
      icon: Users,
      color: "text-[var(--info)]",
      sub: `${a?.members.total ?? 0} total`,
    },
  ];

  // Pie chart data
  const outcomeData = k
    ? Object.entries(k.jobs_by_outcome_tier).map(([name, value]) => ({ name, value }))
    : [];

  const frameworkData = k
    ? Object.entries(k.jobs_by_framework).map(([name, value]) => ({ name, value }))
    : [];

  const COLORS = ["var(--accent)", "var(--terminal)", "var(--error)", "var(--warning)", "var(--accent)", "var(--cat-purple-fg)", "var(--cat-purple-fg)"];

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {cards.map((card, i) => {
          const Icon = card.icon;
          return (
            <motion.div
              key={card.label}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
              className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4 hover:shadow-md transition-shadow"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-[var(--text-muted)]">{card.label}</span>
                <Icon className={cn("w-4 h-4", card.color)} />
              </div>
              <div className="text-xl font-bold text-[var(--text-primary)]">{card.value}</div>
              <div className="text-xs text-[var(--text-muted)] mt-1">{card.sub}</div>
            </motion.div>
          );
        })}
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Daily jobs sparkline */}
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4">Daily Jobs</h3>
          {a && a.daily_jobs.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={a.daily_jobs}>
                <defs>
                  <linearGradient id="colorJobs" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="var(--accent)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--text-muted)" }} tickFormatter={(v: string) => v.slice(5)} />
                <YAxis tick={{ fontSize: 11, fill: "var(--text-muted)" }} />
                <Tooltip
                  contentStyle={{ background: "var(--bg-primary)", border: "1px solid var(--border-default)", borderRadius: 8 }}
                  labelStyle={{ color: "var(--text-secondary)" }}
                />
                <Area type="monotone" dataKey="count" stroke="var(--accent)" fillOpacity={1} fill="url(#colorJobs)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState message="No daily job data yet — wait for jobs to complete and they'll roll up here by day." />
          )}
        </div>

        {/* Outcome distribution */}
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4">Outcomes</h3>
          {outcomeData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={outcomeData} cx="50%" cy="50%" innerRadius={60} outerRadius={90} paddingAngle={3} dataKey="value">
                  {outcomeData.map((_, i) => (
                    <Cell key={`cell-${i}`} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Legend />
                <Tooltip
                  contentStyle={{ background: "var(--bg-primary)", border: "1px solid var(--border-default)", borderRadius: 8 }}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState message="No outcome tier data yet — completed jobs will populate this distribution." />
          )}
        </div>
      </div>

      {/* Framework breakdown */}
      <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4">Framework Usage</h3>
        {frameworkData.length > 0 ? (
          <ResponsiveContainer width="100%" height={200}>
            <ReBarChart data={frameworkData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
              <XAxis type="number" tick={{ fontSize: 11, fill: "var(--text-muted)" }} />
              <YAxis dataKey="name" type="category" tick={{ fontSize: 11, fill: "var(--text-muted)" }} width={100} />
              <Tooltip
                contentStyle={{ background: "var(--bg-primary)", border: "1px solid var(--border-default)", borderRadius: 8 }}
              />
              <Bar dataKey="value" fill="var(--accent)" radius={[0, 4, 4, 0]} />
            </ReBarChart>
          </ResponsiveContainer>
        ) : (
          <EmptyState message="No framework data yet — generate environments across multiple frameworks to compare." />
        )}
      </div>
    </div>
  );
}

// ── Trends Tab ───────────────────────────────────────────────────────────

function TrendsTab({ trends }: { trends: { jobs: TrendAnalysis | null; quality: TrendAnalysis | null; costs: TrendAnalysis | null } }) {
  if (!trends.jobs && !trends.quality && !trends.costs) {
    return <EmptyState message="No trend data yet — at least 7 days of job activity is needed to compute trends." />;
  }

  return (
    <div className="space-y-6">
      {trends.jobs && <TrendCard title="Job Volume" trend={trends.jobs} color="var(--accent)" />}
      {trends.quality && <TrendCard title="Quality Score" trend={trends.quality} color="var(--terminal)" />}
      {trends.costs && <TrendCard title="Daily Cost" trend={trends.costs} color="var(--error)" unit="$" />}
    </div>
  );
}

function TrendCard({ title, trend, color, unit = "" }: { title: string; trend: TrendAnalysis; color: string; unit?: string }) {
  const TrendIcon = trend.direction === "up" ? ArrowUpRight : trend.direction === "down" ? ArrowDownRight : Minus;
  const trendColor =
    trend.direction === "up"
      ? title.toLowerCase().includes("cost")
        ? "text-[var(--error)]"
        : "text-[var(--success)]"
      : trend.direction === "down"
        ? title.toLowerCase().includes("cost")
          ? "text-[var(--success)]"
          : "text-[var(--error)]"
        : "text-[var(--text-muted)]";

  return (
    <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            {trend.period_days} days · MA7: {unit}{trend.moving_average_7d.toFixed(2)} · MA30: {unit}{trend.moving_average_30d.toFixed(2)}
          </p>
        </div>
        <div className={cn("flex items-center gap-1 text-sm font-medium", trendColor)}>
          <TrendIcon className="w-4 h-4" />
          {trend.change_pct > 0 ? "+" : ""}
          {trend.change_pct.toFixed(1)}%
        </div>
      </div>

      <ResponsiveContainer width="100%" height={240}>
        <AreaChart data={trend.data_points}>
          <defs>
            <linearGradient id={`grad-${trend.metric_name}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
          <XAxis dataKey="timestamp" tick={{ fontSize: 11, fill: "var(--text-muted)" }} tickFormatter={(v: string) => v.slice(5, 10)} />
          <YAxis tick={{ fontSize: 11, fill: "var(--text-muted)" }} tickFormatter={(v: number) => `${unit}${v}`} />
          <Tooltip
            contentStyle={{ background: "var(--bg-primary)", border: "1px solid var(--border-default)", borderRadius: 8 }}
            formatter={(value: number) => [`${unit}${value.toFixed(2)}`, title]}
          />
          <Area type="monotone" dataKey="value" stroke={color} fill={`url(#grad-${trend.metric_name})`} strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>

      {trend.anomaly_dates.length > 0 && (
        <div className="mt-3 flex items-center gap-2 text-xs text-[var(--warning)]">
          <AlertCircle className="w-3.5 h-3.5" />
          {trend.anomaly_dates.length} anomaly{trend.anomaly_dates.length > 1 ? "ies" : "y"} detected
        </div>
      )}

      {trend.forecast_next_7d !== null && (
        <div className="mt-2 text-xs text-[var(--text-muted)]">
          Forecast (next 7d): {unit}{trend.forecast_next_7d.toFixed(2)}
        </div>
      )}
    </div>
  );
}

// ── Cohorts Tab ────────────────────────────────────────────────────────

function CohortsTab({ cohorts }: { cohorts: Cohort[] }) {
  if (cohorts.length === 0) {
    return <EmptyState message="No cohort data yet — this is computed from teams that have used Eden for at least 14 days." />;
  }

  const data = cohorts.map((c) => ({
    label: c.cohort_label,
    activation: c.activation_rate,
    retention7: c.retention_day_7,
    retention30: c.retention_day_30,
    members: c.total_members,
    jobs: c.avg_jobs_per_member,
  }));

  return (
    <div className="space-y-6">
      {/* Cohort table */}
      <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--border-default)]">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Cohort Analysis</h3>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">Member activation and retention by join month</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[var(--bg-tertiary)] text-[var(--text-muted)] text-xs">
                <th className="text-left px-4 py-2.5 font-medium">Cohort</th>
                <th className="text-right px-4 py-2.5 font-medium">Members</th>
                <th className="text-right px-4 py-2.5 font-medium">Activation</th>
                <th className="text-right px-4 py-2.5 font-medium">7D Retention</th>
                <th className="text-right px-4 py-2.5 font-medium">30D Retention</th>
                <th className="text-right px-4 py-2.5 font-medium">Avg Jobs</th>
                <th className="text-right px-4 py-2.5 font-medium">Quality</th>
                <th className="text-right px-4 py-2.5 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {cohorts.map((c) => (
                <tr key={c.cohort_label} className="hover:bg-[var(--bg-tertiary)]/50 transition-colors">
                  <td className="px-4 py-3 font-medium text-[var(--text-primary)]">{c.cohort_label}</td>
                  <td className="px-4 py-3 text-right text-[var(--text-secondary)]">{c.total_members}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={cn("font-medium", c.activation_rate >= 50 ? "text-[var(--success)]" : "text-[var(--warning)]")}>
                      {c.activation_rate}%
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-[var(--text-secondary)]">{c.retention_day_7}%</td>
                  <td className="px-4 py-3 text-right text-[var(--text-secondary)]">{c.retention_day_30}%</td>
                  <td className="px-4 py-3 text-right text-[var(--text-secondary)]">{c.avg_jobs_per_member}</td>
                  <td className="px-4 py-3 text-right text-[var(--text-secondary)]">{c.avg_quality_score.toFixed(2)}</td>
                  <td className="px-4 py-3 text-right text-[var(--text-secondary)]">${c.total_cost_usd.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Retention chart */}
      <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4">Retention Curves</h3>
        <ResponsiveContainer width="100%" height={260}>
          <ReBarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--text-muted)" }} />
            <YAxis tick={{ fontSize: 11, fill: "var(--text-muted)" }} domain={[0, 100]} />
            <Tooltip
              contentStyle={{ background: "var(--bg-primary)", border: "1px solid var(--border-default)", borderRadius: 8 }}
              formatter={(value: number, name: string) => [`${value.toFixed(1)}%`, name]}
            />
            <Legend />
            <Bar dataKey="activation" name="Activation" fill="var(--accent)" radius={[4, 4, 0, 0]} />
            <Bar dataKey="retention7" name="7D Retention" fill="var(--accent)" radius={[4, 4, 0, 0]} />
            <Bar dataKey="retention30" name="30D Retention" fill="var(--terminal)" radius={[4, 4, 0, 0]} />
          </ReBarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ── Benchmarks Tab ───────────────────────────────────────────────────────

function BenchmarksTab({ benchmarks }: { benchmarks: BenchmarkComparison[] }) {
  if (benchmarks.length === 0) {
    return <EmptyState message="No benchmark data yet — benchmarks populate as more teams use Eden." />;
  }

  const radarData = benchmarks.map((b) => ({
    metric: b.metric_name.replace(/_/g, " "),
    org: Math.min(b.org_value, 100),
    global: Math.min(b.global_avg, 100),
    p90: Math.min(b.global_p90, 100),
  }));

  return (
    <div className="space-y-6">
      <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4">Global Benchmark Comparison</h3>
        <ResponsiveContainer width="100%" height={300}>
          <RadarChart data={radarData}>
            <PolarGrid stroke="var(--border-subtle)" />
            <PolarAngleAxis dataKey="metric" tick={{ fontSize: 11, fill: "var(--text-muted)" }} />
            <PolarRadiusAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} />
            <Radar name="Your Org" dataKey="org" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.2} strokeWidth={2} />
            <Radar name="Global Avg" dataKey="global" stroke="var(--text-muted)" fill="var(--text-muted)" fillOpacity={0.1} strokeWidth={1.5} />
            <Radar name="Global P90" dataKey="p90" stroke="var(--terminal)" fill="var(--terminal)" fillOpacity={0.1} strokeWidth={1.5} />
            <Legend />
            <Tooltip
              contentStyle={{ background: "var(--bg-primary)", border: "1px solid var(--border-default)", borderRadius: 8 }}
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>

      {/* Benchmark cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {benchmarks.map((b) => {
          const isPositive = b.gap_pct > 0;
          const isGood = b.metric_name.includes("cost") || b.metric_name.includes("duration")
            ? !isPositive
            : isPositive;
          return (
            <div key={b.metric_name} className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-[var(--text-primary)] capitalize">{b.metric_name.replace(/_/g, " ")}</span>
                <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-full", isGood ? "bg-[var(--success-bg)] text-[var(--success)]" : "bg-[var(--error-bg)] text-[var(--error)]")}>
                  {b.percentile.toFixed(0)}th percentile
                </span>
              </div>
              <div className="flex items-end gap-3">
                <div>
                  <div className="text-2xl font-bold text-[var(--text-primary)]">{b.org_value.toFixed(2)}</div>
                  <div className="text-xs text-[var(--text-muted)]">Your org</div>
                </div>
                <div className="flex-1 space-y-1.5">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-[var(--text-muted)] w-16">Global avg</span>
                    <div className="flex-1 h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                      <div className="h-full bg-[var(--text-muted)] rounded-full" style={{ width: `${Math.min((b.global_avg / Math.max(b.org_value, b.global_avg)) * 100, 100)}%` }} />
                    </div>
                    <span className="text-[var(--text-secondary)] w-12 text-right">{b.global_avg.toFixed(2)}</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-[var(--text-muted)] w-16">Global P90</span>
                    <div className="flex-1 h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                      <div className="h-full bg-[var(--success)] rounded-full" style={{ width: `${Math.min((b.global_p90 / Math.max(b.org_value, b.global_p90)) * 100, 100)}%` }} />
                    </div>
                    <span className="text-[var(--text-secondary)] w-12 text-right">{b.global_p90.toFixed(2)}</span>
                  </div>
                </div>
              </div>
              <div className={cn("mt-2 text-xs font-medium", isGood ? "text-[var(--success)]" : "text-[var(--error)]")}>
                {isGood ? "↑" : "↓"} {Math.abs(b.gap_pct).toFixed(1)}% vs global average
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Datasets Tab ─────────────────────────────────────────────────────────

function DatasetsTab({ datasets, orgId, onRefresh }: { datasets: DatasetItem[]; orgId: string; onRefresh: () => void }) {
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", min_quality_score: "0.7", limit: "1000", tags: "" });

  const handleGenerate = async () => {
    setGenerating(true);
    setGenError("");
    try {
      await api.generateTrainingDataset(orgId, {
        name: form.name || `Training Dataset ${new Date().toLocaleDateString()}`,
        min_quality_score: parseFloat(form.min_quality_score),
        limit: parseInt(form.limit),
        tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
      });
      setShowForm(false);
      setForm({ name: "", min_quality_score: "0.7", limit: "1000", tags: "" });
      onRefresh();
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Gold Training Datasets</h3>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] text-xs font-medium rounded-lg hover:bg-[var(--accent-hover)] transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Generate Dataset
        </button>
      </div>

      {showForm && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4 space-y-3"
        >
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-medium text-[var(--text-muted)] mb-1 block">Name</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="My Training Dataset"
                className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/50"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-[var(--text-muted)] mb-1 block">Min Quality</label>
              <input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={form.min_quality_score}
                onChange={(e) => setForm({ ...form, min_quality_score: e.target.value })}
                className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/50"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-[var(--text-muted)] mb-1 block">Limit</label>
              <input
                type="number"
                min="1"
                max="50000"
                value={form.limit}
                onChange={(e) => setForm({ ...form, limit: e.target.value })}
                className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/50"
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-[var(--text-muted)] mb-1 block">Tags (comma-separated)</label>
            <input
              type="text"
              value={form.tags}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
              placeholder="python, multi-agent, ..."
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/50"
            />
          </div>
          {genError && <p className="text-xs text-[var(--error)]">{genError}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] text-sm font-medium rounded-lg hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50"
            >
              {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : "Generate"}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-4 py-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              Cancel
            </button>
          </div>
        </motion.div>
      )}

      {datasets.length === 0 ? (
        <EmptyState message="No training datasets yet. Generate an environment to start collecting signal for model fine-tuning." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {datasets.map((ds) => (
            <div key={ds.dataset_id} className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Database className="w-4 h-4 text-[var(--accent)]" />
                  <span className="text-sm font-medium text-[var(--text-primary)] truncate">{ds.name}</span>
                </div>
                <span className="text-[10px] font-medium px-1.5 py-0.5 bg-[var(--accent-faint)] text-[var(--accent)] rounded-full">
                  {ds.dataset_type}
                </span>
              </div>
              <div className="text-xs text-[var(--text-muted)] mb-3">{ds.entry_count.toLocaleString()} entries · v{ds.version}</div>
              <div className="flex flex-wrap gap-1 mb-3">
                {ds.tags.map((tag) => (
                  <span key={tag} className="text-[10px] px-1.5 py-0.5 bg-[var(--bg-tertiary)] text-[var(--text-muted)] rounded">
                    {tag}
                  </span>
                ))}
              </div>
              <div className="text-xs text-[var(--text-muted)]">{new Date(ds.created_at).toLocaleDateString()}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Synthetic Tab ──────────────────────────────────────────────────────

function SyntheticTab({ datasets, orgId, onRefresh }: { datasets: DatasetItem[]; orgId: string; onRefresh: () => void }) {
  const [selectedDataset, setSelectedDataset] = useState("");
  const [strategies, setStrategies] = useState<string[]>(["paraphrase", "adversarial", "curriculum"]);
  const [augmenting, setAugmenting] = useState(false);
  const [augResult, setAugResult] = useState<{ total: number; byStrategy: Record<string, number> } | null>(null);
  const [augError, setAugError] = useState("");

  const handleAugment = async () => {
    if (!selectedDataset) return;
    setAugmenting(true);
    setAugError("");
    setAugResult(null);
    try {
      const result = await api.augmentSyntheticData(orgId, {
        dataset_id: selectedDataset,
        strategies,
        counts: { paraphrase: 3, adversarial: 2, curriculum: 5 },
      });
      const byStrategy: Record<string, number> = {};
      Object.entries(result.by_strategy).forEach(([k, v]) => {
        byStrategy[k] = Array.isArray(v) ? v.length : 0;
      });
      setAugResult({ total: result.total_variants_generated, byStrategy });
      onRefresh();
    } catch (e) {
      setAugError(e instanceof Error ? e.message : "Augmentation failed");
    } finally {
      setAugmenting(false);
    }
  };

  const toggleStrategy = (s: string) => {
    setStrategies((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  return (
    <div className="space-y-6">
      <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">Synthetic Data Augmentation</h3>
        <p className="text-xs text-[var(--text-muted)] mb-4">
          Generate paraphrased, adversarial, and curriculum variants from an existing dataset.
        </p>

        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Source Dataset</label>
            <select
              value={selectedDataset}
              onChange={(e) => setSelectedDataset(e.target.value)}
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/50"
            >
              <option value="">Select a dataset...</option>
              {datasets.map((ds) => (
                <option key={ds.dataset_id} value={ds.dataset_id}>
                  {ds.name} ({ds.entry_count} entries)
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Strategies</label>
            <div className="flex flex-wrap gap-2">
              {["paraphrase", "composition", "adversarial", "curriculum"].map((s) => (
                <button
                  key={s}
                  onClick={() => toggleStrategy(s)}
                  className={cn(
                    "px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors capitalize",
                    strategies.includes(s)
                      ? "bg-[var(--accent-faint)] border-[var(--accent)] text-[var(--accent)]"
                      : "bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {augError && <p className="text-xs text-[var(--error)]">{augError}</p>}

          {augResult && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-[var(--success-bg)] border border-[var(--success)]/20 rounded-lg p-3"
            >
              <div className="flex items-center gap-2 text-sm text-[var(--success)] font-medium">
                <Sparkles className="w-4 h-4" />
                Generated {augResult.total} synthetic variants
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {Object.entries(augResult.byStrategy).map(([k, v]) => (
                  <span key={k} className="text-xs px-2 py-1 bg-[var(--bg-primary)] rounded-full text-[var(--text-secondary)]">
                    {k}: {v}
                  </span>
                ))}
              </div>
            </motion.div>
          )}

          <button
            onClick={handleAugment}
            disabled={!selectedDataset || strategies.length === 0 || augmenting}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] text-sm font-medium rounded-lg hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50"
          >
            {augmenting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            Augment Dataset
          </button>
        </div>
      </div>

      {/* Strategy descriptions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[
          {
            name: "Paraphrase",
            desc: "Rephrase prompts while preserving intent using template-based and LLM-driven variation.",
            icon: FileText,
            color: "text-[var(--accent)]",
          },
          {
            name: "Composition",
            desc: "Combine multiple scenarios into hybrid tasks that test composition of skills.",
            icon: Layers,
            color: "text-[var(--info)]",
          },
          {
            name: "Adversarial",
            desc: "Inject edge cases, ambiguities, resource constraints, and exploit surfaces.",
            icon: ShieldAlert,
            color: "text-[var(--error)]",
          },
          {
            name: "Curriculum",
            desc: "Progressively remove scaffolding and increase difficulty across 5 stages.",
            icon: TrendingUp,
            color: "text-[var(--success)]",
          },
        ].map((strategy) => {
          const Icon = strategy.icon;
          return (
            <div key={strategy.name} className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <Icon className={cn("w-4 h-4", strategy.color)} />
                <span className="text-sm font-medium text-[var(--text-primary)]">{strategy.name}</span>
              </div>
              <p className="text-xs text-[var(--text-muted)] leading-relaxed">{strategy.desc}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Empty State ────────────────────────────────────────────────────────

function EmptyState({ message, icon: Icon = BarChart3 }: { message: string; icon?: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl">
      <Icon className="w-10 h-10 text-[var(--text-muted)] mb-3 opacity-50" />
      <p className="text-sm text-[var(--text-muted)]">{message}</p>
    </div>
  );
}
