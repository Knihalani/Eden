"use client";

import { useState, useEffect } from "react";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Lightbulb,
  Activity,
  AlertTriangle,
  BarChart3,
  Database,
  Layers,
  ChevronRight,
  Loader2,
  Search,
  Zap,
  TrendingUp,
  TrendingDown,
  Minus,
  Sparkles,
  FileJson,
  Download,
  Play,
  X,
  CheckCircle2,
  XCircle,
  Info,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { NoOrgState } from "@/components/ui/no-org-state";

interface OverviewData {
  summary: {
    total_traces: number;
    total_insights: number;
    total_disparity_reports: number;
    total_datasets: number;
    high_disparity_count: number;
    avg_disparity_score: number;
  };
  traces: {
    by_realm: Record<string, number>;
    by_outcome: Record<string, number>;
  };
  insights: {
    by_detector: Record<string, number>;
    by_severity: Record<string, number>;
    recent: Array<{
      insight_id: string;
      detector: string;
      severity: string;
      confidence: number;
      summary: string;
      affected_trace_ids: string[];
      pattern: Record<string, unknown>;
      recommended_action: string;
      auto_created_dataset: string | null;
      metadata: Record<string, unknown>;
    }>;
  };
  disparity: {
    reports: Array<{
      report_id: string;
      tenant_id: string;
      env_trace_id: string;
      prod_trace_id: string;
      generated_at: string;
      overall_score: number;
      dimensions: Array<{
        name: string;
        env_value: number;
        prod_value: number;
        gap: number;
        severity: string;
        explanation: string;
      }>;
      recommendations: string[];
      metadata: Record<string, unknown>;
    }>;
    high_disparity_count: number;
    avg_score: number;
  };
  datasets: {
    count: number;
    items: Array<{
      dataset_id: string;
      name: string;
      dataset_type: string;
      version: string;
      tenant_id: string;
      project_id: string;
      created_at: string;
      updated_at: string;
      entry_count: number;
      tags: string[];
      metadata: Record<string, unknown>;
    }>;
  };
}

type Tab = "overview" | "insights" | "disparity" | "datasets" | "closed-loop";

// §3.2 — Closed-loop correlation report (Insights → KB → env quality).
interface CorrelationWeekBucket {
  week_start: string;
  insights_written: number;
  kb_writes: number;
  jobs_in_post_window: number;
  gold_tier_in_post_window: number;
  gold_tier_rate: number | null;
}

interface CorrelationReport {
  organization_id: string | null;
  lookback_days: number;
  weeks: CorrelationWeekBucket[];
  aggregate_post_jobs: number;
  aggregate_post_gold: number;
  aggregate_post_rate: number | null;
  target_slo: number;
  target_slo_met: boolean;
  generated_at: string;
}

export default function InsightsPage() {
  const { currentOrg } = useOrg();
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [runningDetectors, setRunningDetectors] = useState(false);
  const [selectedInsight, setSelectedInsight] = useState<OverviewData["insights"]["recent"][0] | null>(null);
  const [selectedReport, setSelectedReport] = useState<OverviewData["disparity"]["reports"][0] | null>(null);

  useEffect(() => {
    if (!currentOrg) return;
    loadOverview();
  }, [currentOrg]);

  async function loadOverview() {
    if (!currentOrg) return;
    setLoading(true);
    setError("");
    try {
      const data = await api.getInsightsOverview(currentOrg.id);
      setOverview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load insights");
    } finally {
      setLoading(false);
    }
  }

  async function handleRunDetectors() {
    if (!currentOrg) return;
    setRunningDetectors(true);
    try {
      await api.runDetectors(currentOrg.id);
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run detectors");
    } finally {
      setRunningDetectors(false);
    }
  }

  if (!currentOrg) {
    return (
      <NoOrgState
        icon={Lightbulb}
        feature="Insights"
        description="Pattern detection, disparity analysis, and dataset generation light up once your organization has traces to inspect."
      />
    );
  }

  return (
    <div className="p-4 lg:p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)] flex items-center gap-2">
            <Lightbulb className="w-6 h-6 text-[var(--accent)]" />
            Insights
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            Automatic pattern detection, disparity analysis, and dataset generation
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRunDetectors}
            disabled={runningDetectors}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {runningDetectors ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            Run Detectors
          </button>
          <button
            onClick={loadOverview}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-sm font-medium hover:bg-[var(--border-default)] transition-colors"
          >
            <Activity className="w-4 h-4" />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-[var(--error-bg)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--error)]/20">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 p-1 bg-[var(--bg-tertiary)] rounded-xl w-fit">
        {(["overview", "insights", "disparity", "datasets", "closed-loop"] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-4 py-2 rounded-lg text-sm font-medium transition-all",
              activeTab === tab
                ? "bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm"
                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            )}
          >
            {tab === "closed-loop" ? "Closed-loop" : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading && !overview ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div>
      ) : overview ? (
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
          >
            {activeTab === "overview" && <OverviewTab data={overview} />}
            {activeTab === "insights" && (
              <InsightsTab
                data={overview.insights}
                onSelectInsight={setSelectedInsight}
              />
            )}
            {activeTab === "disparity" && (
              <DisparityTab
                data={overview.disparity}
                onSelectReport={setSelectedReport}
              />
            )}
            {activeTab === "datasets" && <DatasetsTab data={overview.datasets} />}
            {activeTab === "closed-loop" && <ClosedLoopTab />}
          </motion.div>
        </AnimatePresence>
      ) : null}

      {/* Insight Detail Modal */}
      <AnimatePresence>
        {selectedInsight && (
          <InsightDetailModal
            insight={selectedInsight}
            onClose={() => setSelectedInsight(null)}
          />
        )}
      </AnimatePresence>

      {/* Report Detail Modal */}
      <AnimatePresence>
        {selectedReport && (
          <ReportDetailModal
            report={selectedReport}
            onClose={() => setSelectedReport(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Overview Tab
// ──────────────────────────────────────────────────────────────────────────

function OverviewTab({ data }: { data: OverviewData }) {
  const { summary, traces, insights, disparity, datasets } = data;

  const cards = [
    {
      label: "Total Traces",
      value: summary.total_traces,
      icon: Layers,
      color: "text-[var(--accent)]",
      bg: "bg-[var(--accent-faint)]",
    },
    {
      label: "Insights Found",
      value: summary.total_insights,
      icon: Sparkles,
      color: "text-[var(--warning)]",
      bg: "bg-[var(--warning-bg)]",
    },
    {
      label: "Disparity Reports",
      value: summary.total_disparity_reports,
      icon: AlertTriangle,
      color: "text-[var(--cat-warning-fg)]",
      bg: "bg-[var(--cat-warning-dim)]",
    },
    {
      label: "Datasets",
      value: summary.total_datasets,
      icon: Database,
      color: "text-[var(--terminal)]",
      bg: "bg-[var(--terminal-faint)]",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((card) => (
          <div
            key={card.label}
            className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                {card.label}
              </span>
              <div className={cn("p-1.5 rounded-lg", card.bg)}>
                <card.icon className={cn("w-4 h-4", card.color)} />
              </div>
            </div>
            <p className="text-2xl font-bold text-[var(--text-primary)]">{card.value}</p>
          </div>
        ))}
      </div>

      {/* Two-column layout */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Insights by Severity */}
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4 flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-[var(--accent)]" />
            Insights by Severity
          </h3>
          <div className="space-y-3">
            {["critical", "high", "medium", "low", "info"].map((severity) => {
              const count = insights.by_severity[severity] || 0;
              const total = summary.total_insights || 1;
              const pct = (count / total) * 100;
              const color =
                severity === "critical"
                  ? "bg-[var(--error)]"
                  : severity === "high"
                  ? "bg-[var(--cat-warning-dim)]"
                  : severity === "medium"
                  ? "bg-[var(--warning)]"
                  : severity === "low"
                  ? "bg-blue-400"
                  : "bg-[var(--text-muted)]";
              return (
                <div key={severity}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="capitalize text-[var(--text-secondary)]">{severity}</span>
                    <span className="font-medium text-[var(--text-primary)]">{count}</span>
                  </div>
                  <div className="h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                    <div
                      className={cn("h-full rounded-full transition-all duration-500", color)}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Traces by Realm */}
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4 flex items-center gap-2">
            <Layers className="w-4 h-4 text-[var(--accent)]" />
            Traces by Realm
          </h3>
          <div className="space-y-3">
            {Object.entries(traces.by_realm).map(([realm, count]) => {
              const total = summary.total_traces || 1;
              const pct = (count / total) * 100;
              return (
                <div key={realm}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="capitalize text-[var(--text-secondary)]">{realm}</span>
                    <span className="font-medium text-[var(--text-primary)]">{count}</span>
                  </div>
                  <div className="h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[var(--accent)] rounded-full transition-all duration-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
            {Object.keys(traces.by_realm).length === 0 && (
              <EmptyState
                icon={Activity}
                title="No traces ingested yet"
                description="Trace ingestion happens automatically as your agents run jobs."
                size="sm"
              />
            )}
          </div>
        </div>
      </div>

      {/* Recent Insights */}
      <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-[var(--accent)]" />
          Recent Insights
        </h3>
        {insights.recent.length > 0 ? (
          <div className="space-y-3">
            {insights.recent.slice(0, 5).map((insight) => (
              <div
                key={insight.insight_id}
                className="flex items-start gap-3 p-3 rounded-lg bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
              >
                <SeverityIcon severity={insight.severity} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                    {insight.summary}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                      {insight.detector}
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">
                      confidence: {(insight.confidence * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={Sparkles}
            title="No insights yet"
            description="Run detectors to discover patterns, model disparities, and quality trends in your outputs."
            size="md"
          />
        )}
      </div>

      {/* Disparity Score */}
      {disparity.reports.length > 0 && (
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-[var(--accent)]" />
            Disparity Summary
          </h3>
          <div className="flex items-center gap-8">
            <div>
              <p className="text-3xl font-bold text-[var(--text-primary)]">
                {(disparity.avg_score * 100).toFixed(1)}%
              </p>
              <p className="text-xs text-[var(--text-muted)]">Average Divergence</p>
            </div>
            <div>
              <p className="text-3xl font-bold text-[var(--cat-warning-fg)]">{disparity.high_disparity_count}</p>
              <p className="text-xs text-[var(--text-muted)]">High Disparity Reports</p>
            </div>
            <div>
              <p className="text-3xl font-bold text-[var(--text-primary)]">{disparity.reports.length}</p>
              <p className="text-xs text-[var(--text-muted)]">Total Reports</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Insights Tab
// ──────────────────────────────────────────────────────────────────────────

function InsightsTab({
  data,
  onSelectInsight,
}: {
  data: OverviewData["insights"];
  onSelectInsight: (insight: OverviewData["insights"]["recent"][0]) => void;
}) {
  const [filterSeverity, setFilterSeverity] = useState<string>("");
  const [filterDetector, setFilterDetector] = useState<string>("");

  const detectors = Object.keys(data.by_detector);
  const severities = ["critical", "high", "medium", "low", "info"];

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={filterSeverity}
          onChange={(e) => setFilterSeverity(e.target.value)}
          className="px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
        >
          <option value="">All Severities</option>
          {severities.map((s) => (
            <option key={s} value={s}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
        <select
          value={filterDetector}
          onChange={(e) => setFilterDetector(e.target.value)}
          className="px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
        >
          <option value="">All Detectors</option>
          {detectors.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>

      {/* Insights List */}
      <div className="space-y-3">
        {data.recent
          .filter((i) => {
            if (filterSeverity && i.severity !== filterSeverity) return false;
            if (filterDetector && i.detector !== filterDetector) return false;
            return true;
          })
          .map((insight) => (
            <button
              key={insight.insight_id}
              onClick={() => onSelectInsight(insight)}
              className="w-full text-left bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4 hover:border-[var(--accent)]/30 transition-colors"
            >
              <div className="flex items-start gap-3">
                <SeverityIcon severity={insight.severity} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--text-primary)]">{insight.summary}</p>
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--accent-faint)] text-[var(--accent)]">
                      {insight.detector}
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">
                      {(insight.confidence * 100).toFixed(0)}% confidence
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">
                      {insight.affected_trace_ids.length} affected
                    </span>
                    {insight.auto_created_dataset && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--terminal-faint)] text-[var(--terminal)]">
                        Dataset: {insight.auto_created_dataset}
                      </span>
                    )}
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0 mt-1" />
              </div>
            </button>
          ))}
        {data.recent.length === 0 && (
          <EmptyState
            icon={Sparkles}
            title="No insights detected yet"
            description="Run detectors to discover quality patterns, model disparities, and training opportunities in your outputs."
            size="lg"
          />
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Disparity Tab
// ──────────────────────────────────────────────────────────────────────────

function DisparityTab({
  data,
  onSelectReport,
}: {
  data: OverviewData["disparity"];
  onSelectReport: (report: OverviewData["disparity"]["reports"][0]) => void;
}) {
  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4">
          <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide">Total Reports</p>
          <p className="text-2xl font-bold text-[var(--text-primary)] mt-1">{data.reports.length}</p>
        </div>
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4">
          <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide">High Disparity</p>
          <p className="text-2xl font-bold text-[var(--cat-warning-fg)] mt-1">{data.high_disparity_count}</p>
        </div>
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4">
          <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide">Avg Score</p>
          <p className="text-2xl font-bold text-[var(--text-primary)] mt-1">
            {(data.avg_score * 100).toFixed(1)}%
          </p>
        </div>
      </div>

      {/* Reports */}
      <div className="space-y-3">
        {data.reports.map((report) => (
          <button
            key={report.report_id}
            onClick={() => onSelectReport(report)}
            className="w-full text-left bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4 hover:border-[var(--accent)]/30 transition-colors"
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "text-xs font-bold px-2 py-0.5 rounded-full",
                    report.overall_score > 0.6
                      ? "bg-[var(--error-bg)] text-[var(--error)]"
                      : report.overall_score > 0.3
                      ? "bg-[var(--cat-warning-dim)] text-[var(--cat-warning-fg)]"
                      : "bg-[var(--terminal-faint)] text-[var(--terminal)]"
                  )}
                >
                  {(report.overall_score * 100).toFixed(0)}%
                </span>
                <span className="text-xs text-[var(--text-muted)]">
                  {new Date(report.generated_at).toLocaleDateString()}
                </span>
              </div>
              <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
            </div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2">
              Environment vs Production Disparity
            </p>
            <div className="flex flex-wrap gap-2">
              {report.dimensions.map((dim) => (
                <span
                  key={dim.name}
                  className={cn(
                    "text-xs px-2 py-0.5 rounded-full",
                    dim.gap > 0.5
                      ? "bg-[var(--error-bg)] text-[var(--error)]"
                      : dim.gap > 0.2
                      ? "bg-[var(--cat-warning-dim)] text-[var(--cat-warning-fg)]"
                      : "bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
                  )}
                >
                  {dim.name}: {(dim.gap * 100).toFixed(0)}%
                </span>
              ))}
            </div>
          </button>
        ))}
        {data.reports.length === 0 && (
          <div className="text-center py-12">
            <AlertTriangle className="w-10 h-10 mx-auto mb-3 text-[var(--text-muted)] opacity-40" />
            <p className="text-sm text-[var(--text-muted)]">No disparity reports yet</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Compare environment and production traces to generate reports
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Datasets Tab
// ──────────────────────────────────────────────────────────────────────────

function DatasetsTab({ data }: { data: OverviewData["datasets"] }) {
  const typeLabels: Record<string, string> = {
    regression_suite: "Regression Suite",
    edge_case_collection: "Edge Cases",
    adversarial_suite: "Adversarial",
    performance_benchmark: "Performance",
    disparity_collection: "Disparity",
    golden_path: "Golden Paths",
  };

  const typeIcons: Record<string, typeof Database> = {
    regression_suite: CheckCircle2,
    edge_case_collection: AlertTriangle,
    adversarial_suite: Zap,
    performance_benchmark: TrendingUp,
    disparity_collection: BarChart3,
    golden_path: Sparkles,
  };

  return (
    <div className="space-y-6">
      <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4">
          Generated Datasets ({data.count})
        </h3>
        <div className="space-y-3">
          {data.items.map((dataset) => {
            const Icon = typeIcons[dataset.dataset_type] || Database;
            return (
              <div
                key={dataset.dataset_id}
                className="flex items-center gap-3 p-3 rounded-lg bg-[var(--bg-secondary)]"
              >
                <div className="p-2 rounded-lg bg-[var(--bg-tertiary)]">
                  <Icon className="w-4 h-4 text-[var(--accent)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--text-primary)]">{dataset.name}</p>
                  <p className="text-xs text-[var(--text-muted)]">
                    {typeLabels[dataset.dataset_type] || dataset.dataset_type} · {dataset.entry_count} entries · v{dataset.version}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    className="p-2 text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
                    title="Export JSONL"
                  >
                    <FileJson className="w-4 h-4" />
                  </button>
                  <button
                    className="p-2 text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
                    title="Download"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
          {data.items.length === 0 && (
            <div className="text-center py-12">
              <Database className="w-10 h-10 mx-auto mb-3 text-[var(--text-muted)] opacity-40" />
              <p className="text-sm text-[var(--text-muted)]">No datasets generated yet</p>
              <p className="text-xs text-[var(--text-muted)] mt-1">
                Datasets are auto-generated from insights and trace analysis
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Modals
// ──────────────────────────────────────────────────────────────────────────

function InsightDetailModal({
  insight,
  onClose,
}: {
  insight: OverviewData["insights"]["recent"][0];
  onClose: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl max-w-lg w-full max-h-[80vh] overflow-y-auto shadow-xl"
      >
        <div className="flex items-center justify-between p-4 border-b border-[var(--border-default)]">
          <div className="flex items-center gap-2">
            <SeverityIcon severity={insight.severity} />
            <h3 className="font-semibold text-[var(--text-primary)]">Insight Detail</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          <p className="text-sm text-[var(--text-primary)]">{insight.summary}</p>
          <div className="flex flex-wrap gap-2">
            <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--accent-faint)] text-[var(--accent)]">
              {insight.detector}
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
              {(insight.confidence * 100).toFixed(0)}% confidence
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
              {insight.affected_trace_ids.length} traces
            </span>
          </div>
          {insight.recommended_action && (
            <div className="bg-[var(--accent-faint)]/50 rounded-lg p-3">
              <p className="text-xs font-medium text-[var(--accent)] mb-1">Recommended Action</p>
              <p className="text-sm text-[var(--text-primary)]">{insight.recommended_action}</p>
            </div>
          )}
          {insight.auto_created_dataset && (
            <div className="flex items-center gap-2 text-sm text-[var(--terminal)]">
              <Database className="w-4 h-4" />
              Auto-created dataset: {insight.auto_created_dataset}
            </div>
          )}
          {Object.keys(insight.pattern).length > 0 && (
            <div>
              <p className="text-xs font-medium text-[var(--text-muted)] mb-2">Pattern</p>
              <pre className="text-xs bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto">
                {JSON.stringify(insight.pattern, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

function ReportDetailModal({
  report,
  onClose,
}: {
  report: OverviewData["disparity"]["reports"][0];
  onClose: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl max-w-lg w-full max-h-[80vh] overflow-y-auto shadow-xl"
      >
        <div className="flex items-center justify-between p-4 border-b border-[var(--border-default)]">
          <h3 className="font-semibold text-[var(--text-primary)]">Disparity Report</h3>
          <button
            onClick={onClose}
            className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "text-lg font-bold px-3 py-1 rounded-full",
                report.overall_score > 0.6
                  ? "bg-[var(--error-bg)] text-[var(--error)]"
                  : report.overall_score > 0.3
                  ? "bg-[var(--cat-warning-dim)] text-[var(--cat-warning-fg)]"
                  : "bg-[var(--terminal-faint)] text-[var(--terminal)]"
              )}
            >
              {(report.overall_score * 100).toFixed(0)}% divergence
            </span>
            <span className="text-xs text-[var(--text-muted)]">
              {new Date(report.generated_at).toLocaleString()}
            </span>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-[var(--text-muted)]">Dimensions</p>
            {report.dimensions.map((dim) => (
              <div key={dim.name} className="bg-[var(--bg-secondary)] rounded-lg p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-[var(--text-primary)] capitalize">
                    {dim.name.replace(/_/g, " ")}
                  </span>
                  <SeverityBadge severity={dim.severity} />
                </div>
                <div className="h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden mb-2">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      dim.gap > 0.5
                        ? "bg-[var(--error)]"
                        : dim.gap > 0.2
                        ? "bg-[var(--cat-warning-dim)]"
                        : "bg-[var(--terminal)]"
                    )}
                    style={{ width: `${dim.gap * 100}%` }}
                  />
                </div>
                <p className="text-xs text-[var(--text-muted)]">{dim.explanation}</p>
              </div>
            ))}
          </div>

          {report.recommendations.length > 0 && (
            <div>
              <p className="text-xs font-medium text-[var(--text-muted)] mb-2">Recommendations</p>
              <ul className="space-y-2">
                {report.recommendations.map((rec, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
                    <ChevronRight className="w-3 h-3 text-[var(--accent)] mt-0.5 flex-shrink-0" />
                    {rec}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function SeverityIcon({ severity }: { severity: string }) {
  const map: Record<string, { icon: typeof AlertTriangle; color: string }> = {
    critical: { icon: XCircle, color: "text-[var(--error)]" },
    high: { icon: AlertTriangle, color: "text-[var(--cat-warning-fg)]" },
    medium: { icon: AlertTriangle, color: "text-[var(--warning)]" },
    low: { icon: Info, color: "text-blue-400" },
    info: { icon: Info, color: "text-[var(--text-muted)]" },
  };
  const { icon: Icon, color } = map[severity] || map.info;
  return <Icon className={cn("w-5 h-5 flex-shrink-0", color)} />;
}

function SeverityBadge({ severity }: { severity: string }) {
  const classes: Record<string, string> = {
    critical: "bg-[var(--error-bg)] text-[var(--error)]",
    high: "bg-[var(--cat-warning-dim)] text-[var(--cat-warning-fg)]",
    medium: "bg-[var(--warning-bg)] text-[var(--warning)]",
    low: "bg-blue-50 text-blue-600",
    info: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
  };
  return (
    <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", classes[severity] || classes.info)}>
      {severity}
    </span>
  );
}


// ────────────────────────────────────────────────────────────────────────────
// §3.2 — Closed-loop correlation tab
// ────────────────────────────────────────────────────────────────────────────

function ClosedLoopTab() {
  const { currentOrg } = useOrg();
  const [report, setReport] = useState<CorrelationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!currentOrg) return;
      setLoading(true);
      setError(null);
      try {
        const r = await api.get<CorrelationReport>(
          `/orgs/${currentOrg.id}/insights/correlation?days=${days}`,
        );
        if (!cancelled) setReport(r);
      } catch (e) {
        if (!cancelled) {
          setError(
            "Could not load the closed-loop report. Run alembic migration 019 and ensure the audit log has data.",
          );
          setReport(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [currentOrg, days]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl p-8 text-center">
        <Info className="w-10 h-10 mx-auto mb-3 text-[var(--text-muted)]" />
        <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-2">
          No correlation data yet
        </h3>
        <p className="text-sm text-[var(--text-muted)] max-w-md mx-auto">
          {error ??
            "Once the closed-loop is established, this view shows whether insight-driven KB entries correlate with downstream gold-tier jobs."}
        </p>
      </div>
    );
  }

  const ratePct = report.aggregate_post_rate
    ? (report.aggregate_post_rate * 100).toFixed(1)
    : "—";
  const targetPct = (report.target_slo * 100).toFixed(0);

  return (
    <div className="space-y-6">
      {/* Headline card */}
      <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold text-[var(--text-primary)]">
              Closed-loop measurement (§3.2)
            </h3>
            <p className="text-sm text-[var(--text-muted)] mt-1">
              Did insight-driven KB entries correlate with gold-tier jobs in the post-write window?
            </p>
          </div>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="text-sm border border-[var(--border-default)] rounded-lg px-3 py-1.5 bg-[var(--bg-primary)] text-[var(--text-primary)]"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={180}>Last 180 days</option>
          </select>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide mb-1">
              Aggregate gold rate
            </div>
            <div className="text-3xl font-bold text-[var(--text-primary)]">
              {ratePct}%
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-1">
              target ≥ {targetPct}%
            </div>
          </div>
          <div>
            <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide mb-1">
              SLO target met
            </div>
            <div
              className={cn(
                "text-3xl font-bold",
                report.target_slo_met
                  ? "text-[var(--terminal)]"
                  : "text-[var(--warning)]",
              )}
            >
              {report.target_slo_met ? "✓ YES" : "✗ NO"}
            </div>
          </div>
          <div>
            <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide mb-1">
              Jobs in window
            </div>
            <div className="text-3xl font-bold text-[var(--text-primary)]">
              {report.aggregate_post_jobs}
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-1">
              {report.aggregate_post_gold} gold
            </div>
          </div>
        </div>
      </div>

      {/* Per-week table */}
      <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-[var(--border-default)] flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Per-week breakdown
          </h3>
          <span className="text-xs text-[var(--text-muted)]">
            generated {new Date(report.generated_at).toLocaleString()}
          </span>
        </div>
        {report.weeks.length === 0 ? (
          <div className="px-6 py-8 text-center text-sm text-[var(--text-muted)]">
            No insights written in the {days}-day window.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-[var(--bg-tertiary)] text-[var(--text-muted)] text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Week</th>
                <th className="text-right px-4 py-2 font-medium">Insights</th>
                <th className="text-right px-4 py-2 font-medium">KB writes</th>
                <th className="text-right px-4 py-2 font-medium">Jobs (post)</th>
                <th className="text-right px-4 py-2 font-medium">Gold-tier</th>
                <th className="text-right px-4 py-2 font-medium">Gold rate</th>
              </tr>
            </thead>
            <tbody>
              {report.weeks.map((w) => (
                <tr
                  key={w.week_start}
                  className="border-t border-[var(--border-default)] hover:bg-[var(--bg-tertiary)]/50"
                >
                  <td className="px-4 py-2 font-mono text-xs">
                    {w.week_start}
                  </td>
                  <td className="px-4 py-2 text-right">{w.insights_written}</td>
                  <td className="px-4 py-2 text-right">{w.kb_writes}</td>
                  <td className="px-4 py-2 text-right">
                    {w.jobs_in_post_window}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {w.gold_tier_in_post_window}
                  </td>
                  <td className="px-4 py-2 text-right font-medium">
                    {w.gold_tier_rate
                      ? `${(w.gold_tier_rate * 100).toFixed(1)}%`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
