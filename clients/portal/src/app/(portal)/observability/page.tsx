"use client";

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { api, type ObservabilityTrace } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { ScoresTab } from "./ScoresTab";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  FileJson,
  Filter,
  Gauge,
  GitCompare,
  Layers,
  Loader2,
  Search,
  TreePine,
  X,
  Zap,
  Play,
  Pause,
  ArrowRight,
  CheckCircle2,
  XCircle,
  Info,
  Flame,
  Eye,
  EyeOff,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { NoOrgState } from "@/components/ui/no-org-state";

type Tab = "traces" | "tree" | "timeline" | "heatmap" | "compare" | "scores";

interface TraceItem extends ObservabilityTrace {}

interface TraceTreeData {
  trace_id: string;
  tenant_id: string;
  realm: string;
  root_spans: Array<Record<string, unknown>>;
  total_duration_ms: number;
  span_count: number;
  outcome: string | null;
}

interface TimelineData {
  trace_id: string;
  steps: Array<{
    name: string;
    start_ms: number;
    end_ms: number;
    duration_ms: number;
    event_type: string;
    outcome: string | null;
  }>;
  total_duration_ms: number;
  markers: Array<{
    at_ms: number;
    label: string;
    severity: string;
  }>;
}

interface HeatmapData {
  metric_name: string;
  buckets: Array<{ x: string; y: string; value: number; count: number }>;
  x_labels: string[];
  y_labels: string[];
  min_value: number;
  max_value: number;
}

interface ComparativeData {
  env_trace_id: string;
  prod_trace_id: string;
  overall_score: number;
  dimensions: Array<{
    name: string;
    env_value: unknown;
    prod_value: unknown;
    gap: number;
    severity: string;
    explanation: string;
  }>;
  recommendations: string[];
  metadata: Record<string, unknown>;
}

export default function ObservabilityPage() {
  const { currentOrg } = useOrg();
  const [activeTab, setActiveTab] = useState<Tab>("traces");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Trace list state
  const [traces, setTraces] = useState<TraceItem[]>([]);
  const [traceFilter, setTraceFilter] = useState({ realm: "", outcome: "", agent_id: "" });

  // Selected trace
  const [selectedTraceId, setSelectedTraceId] = useState<string>("");

  // Trace detail data
  const [traceTree, setTraceTree] = useState<TraceTreeData | null>(null);
  const [timeline, setTimeline] = useState<TimelineData | null>(null);

  // Heatmap
  const [heatmapMetric, setHeatmapMetric] = useState("duration_ms");
  const [heatmapData, setHeatmapData] = useState<HeatmapData | null>(null);

  // Compare
  const [envTraceId, setEnvTraceId] = useState("");
  const [prodTraceId, setProdTraceId] = useState("");
  const [compareResult, setCompareResult] = useState<ComparativeData | null>(null);

  // Export
  const [exportFormat, setExportFormat] = useState("jsonl");
  const [exportData, setExportData] = useState<string>("");
  const [showExportModal, setShowExportModal] = useState(false);

  const loadTraces = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError("");
    try {
      const data = await api.listObservabilityTraces(currentOrg.id, {
        ...(traceFilter.realm ? { realm: traceFilter.realm } : {}),
        ...(traceFilter.outcome ? { outcome: traceFilter.outcome } : {}),
        ...(traceFilter.agent_id ? { agent_id: traceFilter.agent_id } : {}),
        limit: 50,
      });
      setTraces(data.traces);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load traces");
    } finally {
      setLoading(false);
    }
  }, [currentOrg, traceFilter]);

  useEffect(() => {
    if (currentOrg) loadTraces();
  }, [currentOrg, loadTraces]);

  async function loadTraceTree(traceId: string) {
    if (!currentOrg) return;
    setLoading(true);
    try {
      const data = await api.getTraceTree(currentOrg.id, traceId);
      setTraceTree(data);
      setSelectedTraceId(traceId);
      setActiveTab("tree");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load trace tree");
    } finally {
      setLoading(false);
    }
  }

  async function loadTimeline(traceId: string) {
    if (!currentOrg) return;
    setLoading(true);
    try {
      const data = await api.getTraceTimeline(currentOrg.id, traceId);
      setTimeline(data);
      setSelectedTraceId(traceId);
      setActiveTab("timeline");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load timeline");
    } finally {
      setLoading(false);
    }
  }

  async function loadHeatmap() {
    if (!currentOrg) return;
    setLoading(true);
    try {
      const data = await api.getObservabilityHeatmap(currentOrg.id, heatmapMetric, { days: 7 });
      setHeatmapData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load heatmap");
    } finally {
      setLoading(false);
    }
  }

  async function handleCompare() {
    if (!currentOrg || !envTraceId || !prodTraceId) {
      setError("Please enter both environment and production trace IDs");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const data = await api.compareObservabilityTraces(currentOrg.id, envTraceId, prodTraceId);
      setCompareResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Comparison failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleExport(traceId: string) {
    if (!currentOrg) return;
    setLoading(true);
    try {
      const data = await api.exportTrace(currentOrg.id, traceId, exportFormat);
      setExportData(data.data);
      setShowExportModal(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setLoading(false);
    }
  }

  function handleDownloadExport() {
    const blob = new Blob([exportData], {
      type: exportFormat === "csv" ? "text/csv" : exportFormat === "json" ? "application/json" : "application/jsonlines+json",
    });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trace_export_${selectedTraceId || "export"}.${exportFormat === "jsonl" ? "jsonl" : exportFormat}`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }

  if (!currentOrg) {
    return (
      <NoOrgState
        icon={Activity}
        feature="Observability"
        description="Real-time telemetry, trace trees, and heatmaps fill in once your organization starts running jobs."
      />
    );
  }

  return (
    <div className="p-4 lg:p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)] flex items-center gap-2">
            <Activity className="w-6 h-6 text-[var(--accent)]" />
            Observability
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            Real-time telemetry, trace trees, heatmaps, and comparative analysis
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadTraces}
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
      <div className="flex items-center gap-1 p-1 bg-[var(--bg-tertiary)] rounded-xl w-fit flex-wrap">
        {([
          { key: "traces" as Tab, label: "Traces", icon: Layers },
          { key: "tree" as Tab, label: "Trace Tree", icon: TreePine },
          { key: "timeline" as Tab, label: "Timeline", icon: Clock },
          { key: "heatmap" as Tab, label: "Heatmap", icon: BarChart3 },
          { key: "compare" as Tab, label: "Compare", icon: GitCompare },
          // Phase 7.1b — judges tab surfaces the per-trace scores
          // emitted by the LLM-as-judge pipeline.
          { key: "scores" as Tab, label: "Scores", icon: Gauge },
        ]).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => {
              setActiveTab(key);
              if (key === "heatmap" && !heatmapData) loadHeatmap();
            }}
            className={cn(
              "px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2",
              activeTab === key
                ? "bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm"
                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            )}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {/* Content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
        >
          {activeTab === "traces" && (
            <TracesTab
              traces={traces}
              loading={loading}
              filter={traceFilter}
              onFilterChange={setTraceFilter}
              onSelectTrace={(id) => {
                setSelectedTraceId(id);
                loadTraceTree(id);
              }}
              onViewTimeline={(id) => loadTimeline(id)}
              onExport={(id) => handleExport(id)}
            />
          )}
          {activeTab === "tree" && (
            <TraceTreeTab
              traceTree={traceTree}
              selectedTraceId={selectedTraceId}
              onBack={() => setActiveTab("traces")}
            />
          )}
          {activeTab === "timeline" && (
            <TimelineTab
              timeline={timeline}
              selectedTraceId={selectedTraceId}
              onBack={() => setActiveTab("traces")}
            />
          )}
          {activeTab === "heatmap" && (
            <HeatmapTab
              data={heatmapData}
              metric={heatmapMetric}
              onMetricChange={setHeatmapMetric}
              onRefresh={loadHeatmap}
              loading={loading}
            />
          )}
          {activeTab === "compare" && (
            <CompareTab
              envTraceId={envTraceId}
              prodTraceId={prodTraceId}
              onEnvChange={setEnvTraceId}
              onProdChange={setProdTraceId}
              onCompare={handleCompare}
              result={compareResult}
              loading={loading}
            />
          )}
          {activeTab === "scores" && (
            <ScoresTab
              orgId={currentOrg?.id ?? ""}
              traceId={selectedTraceId ?? undefined}
            />
          )}
        </motion.div>
      </AnimatePresence>

      {/* Export Modal */}
      <AnimatePresence>
        {showExportModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
            onClick={() => setShowExportModal(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl max-w-2xl w-full max-h-[80vh] overflow-hidden shadow-xl flex flex-col"
            >
              <div className="flex items-center justify-between p-4 border-b border-[var(--border-default)]">
                <h3 className="font-semibold text-[var(--text-primary)] flex items-center gap-2">
                  <Download className="w-4 h-4 text-[var(--accent)]" />
                  Export Trace
                </h3>
                <button
                  onClick={() => setShowExportModal(false)}
                  className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-4 space-y-4 overflow-auto flex-1">
                <div className="flex items-center gap-2">
                  {["jsonl", "json", "csv"].map((fmt) => (
                    <button
                      key={fmt}
                      onClick={() => setExportFormat(fmt)}
                      className={cn(
                        "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
                        exportFormat === fmt
                          ? "bg-[var(--accent)] text-[var(--bg-base)]"
                          : "bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      )}
                    >
                      {fmt.toUpperCase()}
                    </button>
                  ))}
                  <button
                    onClick={handleDownloadExport}
                    className="ml-auto inline-flex items-center gap-2 px-3 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-xs font-medium hover:bg-[var(--accent-hover)] transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download
                  </button>
                </div>
                <pre className="text-xs bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto max-h-[50vh]">
                  {exportData.slice(0, 5000)}
                  {exportData.length > 5000 && "\n\n... (truncated)"}
                </pre>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Traces Tab
// ──────────────────────────────────────────────────────────────────────────

function TracesTab({
  traces,
  loading,
  filter,
  onFilterChange,
  onSelectTrace,
  onViewTimeline,
  onExport,
}: {
  traces: TraceItem[];
  loading: boolean;
  filter: { realm: string; outcome: string; agent_id: string };
  onFilterChange: (f: { realm: string; outcome: string; agent_id: string }) => void;
  onSelectTrace: (id: string) => void;
  onViewTimeline: (id: string) => void;
  onExport: (id: string) => void;
}) {
  const outcomes = ["success", "failure", "partial", "timeout", "crash"];

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-3">
        <Filter className="w-4 h-4 text-[var(--text-muted)]" />
        <select
          value={filter.realm}
          onChange={(e) => onFilterChange({ ...filter, realm: e.target.value })}
          className="px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
        >
          <option value="">All Realms</option>
          <option value="environment">Environment</option>
          <option value="production">Production</option>
        </select>
        <select
          value={filter.outcome}
          onChange={(e) => onFilterChange({ ...filter, outcome: e.target.value })}
          className="px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
        >
          <option value="">All Outcomes</option>
          {outcomes.map((o) => (
            <option key={o} value={o}>{o.charAt(0).toUpperCase() + o.slice(1)}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Agent ID..."
          value={filter.agent_id}
          onChange={(e) => onFilterChange({ ...filter, agent_id: e.target.value })}
          className="px-3 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
        />
      </div>

      {loading && traces.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div>
      ) : traces.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No traces found"
          description="Send telemetry from the Eden SDK or run a job — traces will appear here as your agents run."
          size="lg"
        />
      ) : (
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Trace ID</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Realm</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Outcome</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Spans</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Duration</th>
                  {/* Phase 7.1a — streaming-metric column header. Shown
                     when any trace row carries ttft/itl/tpot values
                     (the SDK's llm_completion_stream events). */}
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Streaming</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {traces.map((trace) => (
                  <tr key={trace.trace_id} className="hover:bg-[var(--bg-tertiary)]/50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-[var(--text-primary)]">
                      {trace.trace_id.slice(0, 16)}...
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn(
                        "text-xs px-2 py-0.5 rounded-full font-medium",
                        trace.realm === "environment"
                          ? "bg-blue-50 text-blue-600"
                          : "bg-[var(--cat-purple-dim)] text-[var(--cat-purple-fg)]"
                      )}>
                        {trace.realm}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <OutcomeBadge outcome={trace.outcome} />
                    </td>
                    <td className="px-4 py-3 text-[var(--text-secondary)]">{trace.span_count}</td>
                    <td className="px-4 py-3 text-[var(--text-secondary)]">{trace.duration_ms.toFixed(0)}ms</td>
                    {/* Phase 7.1a — per-trace streaming-metric summary. Renders
                         TTFT / ITL / TPOT as a compact triple when the
                         trace has any streaming events. Falls back to a
                         muted dash when the trace is non-streaming. */}
                    <td className="px-4 py-3 text-[var(--text-muted)] text-xs">
                      {trace.streaming_metrics ? (
                        <div className="flex flex-col gap-0.5">
                          <span>TTFT {trace.streaming_metrics.ttft_ms?.toFixed(0)}ms</span>
                          <span>ITL {trace.streaming_metrics.itl_ms_avg?.toFixed(1)}ms</span>
                          <span>TPOT {trace.streaming_metrics.tpot_ms?.toFixed(1)}ms</span>
                        </div>
                      ) : (
                        <span>—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => onSelectTrace(trace.trace_id)}
                          className="p-1.5 text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent-faint)] rounded-lg transition-colors"
                          title="View Trace Tree"
                        >
                          <TreePine className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => onViewTimeline(trace.trace_id)}
                          className="p-1.5 text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent-faint)] rounded-lg transition-colors"
                          title="View Timeline"
                        >
                          <Clock className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => onExport(trace.trace_id)}
                          className="p-1.5 text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent-faint)] rounded-lg transition-colors"
                          title="Export"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Trace Tree Tab
// ──────────────────────────────────────────────────────────────────────────

function TraceTreeTab({
  traceTree,
  selectedTraceId,
  onBack,
}: {
  traceTree: TraceTreeData | null;
  selectedTraceId: string;
  onBack: () => void;
}) {
  if (!traceTree) {
    return (
      <div className="text-center py-16 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl">
        <TreePine className="w-12 h-12 mx-auto mb-3 text-[var(--text-muted)] opacity-40" />
        <p className="text-sm text-[var(--text-muted)]">Select a trace to view its tree</p>
        <button
          onClick={onBack}
          className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors"
        >
          <ArrowRight className="w-4 h-4" />
          Go to Traces
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <TreePine className="w-4 h-4 text-[var(--accent)]" />
            Trace Tree
          </h3>
          <p className="text-xs text-[var(--text-muted)] font-mono mt-0.5">{selectedTraceId}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-xs text-[var(--text-muted)]">{traceTree.span_count} spans</p>
            <p className="text-xs text-[var(--text-muted)]">{traceTree.total_duration_ms.toFixed(0)}ms total</p>
          </div>
          <button
            onClick={onBack}
            className="px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] transition-colors"
          >
            Back
          </button>
        </div>
      </div>

      <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4 overflow-x-auto">
        <div className="space-y-1 min-w-[400px]">
          {traceTree.root_spans.map((span, idx) => (
            <SpanNode key={idx} span={span} depth={0} />
          ))}
          {traceTree.root_spans.length === 0 && (
            <EmptyState
              icon={Activity}
              title="No spans in trace tree"
              description="This trace has no recorded spans — the agent may not have started yet."
              size="sm"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SpanNode({ span, depth }: { span: Record<string, unknown>; depth: number }) {
  const [expanded, setExpanded] = useState(true);
  const children = (span.children as Array<Record<string, unknown>>) || [];
  const hasChildren = children.length > 0;
  const name = (span.name as string) || (span.event_type as string) || "unknown";
  const duration = (span.duration_ms as number) || 0;
  const outcome = span.outcome as string | null;

  return (
    <div>
      <div
        className="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
        style={{ paddingLeft: `${depth * 24 + 8}px` }}
      >
        {hasChildren ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        ) : (
          <div className="w-4" />
        )}
        <span className={cn(
          "w-2 h-2 rounded-full flex-shrink-0",
          outcome === "success" ? "bg-[var(--terminal)]" :
          outcome === "failure" ? "bg-[var(--error)]" :
          outcome === "partial" ? "bg-[var(--warning)]" :
          "bg-[var(--text-muted)]"
        )} />
        <span className="text-sm text-[var(--text-primary)] font-medium truncate">{name}</span>
        <span className="text-xs text-[var(--text-muted)] ml-auto flex-shrink-0">{duration.toFixed(1)}ms</span>
      </div>
      <AnimatePresence>
        {expanded && hasChildren && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
          >
            {children.map((child, idx) => (
              <SpanNode key={idx} span={child} depth={depth + 1} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Timeline Tab
// ──────────────────────────────────────────────────────────────────────────

function TimelineTab({
  timeline,
  selectedTraceId,
  onBack,
}: {
  timeline: TimelineData | null;
  selectedTraceId: string;
  onBack: () => void;
}) {
  if (!timeline) {
    return (
      <div className="text-center py-16 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl">
        <Clock className="w-12 h-12 mx-auto mb-3 text-[var(--text-muted)] opacity-40" />
        <p className="text-sm text-[var(--text-muted)]">Select a trace to view its timeline</p>
        <button
          onClick={onBack}
          className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors"
        >
          <ArrowRight className="w-4 h-4" />
          Go to Traces
        </button>
      </div>
    );
  }

  const totalMs = timeline.total_duration_ms || 1;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Clock className="w-4 h-4 text-[var(--accent)]" />
            Step Timeline
          </h3>
          <p className="text-xs text-[var(--text-muted)] font-mono mt-0.5">{selectedTraceId}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-xs text-[var(--text-muted)]">{timeline.steps.length} steps</p>
            <p className="text-xs text-[var(--text-muted)]">{totalMs.toFixed(0)}ms total</p>
          </div>
          <button
            onClick={onBack}
            className="px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] transition-colors"
          >
            Back
          </button>
        </div>
      </div>

      <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4 space-y-3">
        {timeline.steps.map((step, idx) => {
          const leftPct = (step.start_ms / totalMs) * 100;
          const widthPct = Math.max((step.duration_ms / totalMs) * 100, 0.5);
          return (
            <div key={idx} className="relative">
              <div className="flex items-center gap-3 mb-1">
                <span className="text-xs text-[var(--text-muted)] w-8 text-right">{idx + 1}</span>
                <span className="text-sm font-medium text-[var(--text-primary)]">{step.name}</span>
                <span className="text-xs text-[var(--text-muted)] ml-auto">{step.duration_ms.toFixed(1)}ms</span>
              </div>
              <div className="relative h-6 bg-[var(--bg-tertiary)] rounded-full overflow-hidden ml-11">
                <div
                  className={cn(
                    "absolute h-full rounded-full transition-all",
                    step.outcome === "success" ? "bg-[var(--terminal)]/80" :
                    step.outcome === "failure" ? "bg-[var(--error)]/80" :
                    step.outcome === "partial" ? "bg-[var(--warning)]/80" :
                    "bg-[var(--accent)]/60"
                  )}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                />
              </div>
            </div>
          );
        })}

        {/* Markers */}
        {timeline.markers.length > 0 && (
          <div className="mt-6 pt-4 border-t border-[var(--border-default)]">
            <h4 className="text-xs font-semibold text-[var(--text-muted)] mb-3">Markers</h4>
            <div className="space-y-2">
              {timeline.markers.map((marker, idx) => (
                <div key={idx} className="flex items-center gap-3 p-2 rounded-lg bg-[var(--bg-secondary)]">
                  <span className={cn(
                    "w-2 h-2 rounded-full flex-shrink-0",
                    marker.severity === "high" ? "bg-[var(--error)]" : "bg-[var(--warning)]"
                  )} />
                  <span className="text-xs text-[var(--text-muted)] w-16">{marker.at_ms.toFixed(0)}ms</span>
                  <span className="text-sm text-[var(--text-primary)]">{marker.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Heatmap Tab
// ──────────────────────────────────────────────────────────────────────────

function HeatmapTab({
  data,
  metric,
  onMetricChange,
  onRefresh,
  loading,
}: {
  data: HeatmapData | null;
  metric: string;
  onMetricChange: (m: string) => void;
  onRefresh: () => void;
  loading: boolean;
}) {
  if (!data && !loading) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No heatmap data loaded"
        description="Load the heatmap to visualize where the pipeline spends its time and where reward is dropping."
        size="lg"
        action={
          <button
            onClick={onRefresh}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors"
          >
            <Zap className="w-4 h-4" />
            Load Heatmap
          </button>
        }
      />
    );
  }

  // Phase 7.1a — extended metric list now includes the new
  // streaming-metric keys (TTFT / ITL avg / TPOT / completion
  // duration / cache-hit / server-request) and the OTel-canonical
  // duration_ms_otel. These are all populated by the OTel decoder
  // and the SDK auto-instrument, and they slot into the same
  // heatmap query path that duration_ms has always used.
  const metrics = [
    "duration_ms",
    "duration_ms_otel",
    "ttft_ms",
    "itl_ms_avg",
    "tpot_ms",
    "completion_duration_ms",
    "server_request_duration_ms",
    "cache_hit_duration_ms",
    "reward",
    "step_duration_ms",
    "cumulative_reward",
  ];

  // Build a lookup map for bucket values
  const bucketMap = new Map<string, number>();
  data?.buckets.forEach((b) => {
    bucketMap.set(`${b.x}|${b.y}`, b.value);
  });

  const minVal = data?.min_value ?? 0;
  const maxVal = data?.max_value ?? 1;
  const range = Math.max(maxVal - minVal, 0.001);

  function getColor(value: number): string {
    const ratio = (value - minVal) / range;
    // interpolate from blue (low) to purple (mid) to red (high) using
    // the --heat-* tokens defined in globals.css
    if (ratio < 0.33) {
      return `rgba(var(--heat-low), ${0.15 + ratio * 1.5})`;
    } else if (ratio < 0.66) {
      return `rgba(var(--heat-mid), ${0.2 + (ratio - 0.33) * 1.5})`;
    } else {
      return `rgba(var(--heat-high), ${0.25 + (ratio - 0.66) * 2})`;
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <select
            value={metric}
            onChange={(e) => onMetricChange(e.target.value)}
            className="px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
          >
            {metrics.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <button
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3 py-2 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-sm font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            Refresh
          </button>
        </div>
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <span className="w-3 h-3 rounded" style={{ background: "rgba(var(--heat-low), 0.4)" }} />
          Low
          <span className="w-3 h-3 rounded" style={{ background: "rgba(var(--heat-mid), 0.5)" }} />
          Mid
          <span className="w-3 h-3 rounded" style={{ background: "rgba(var(--heat-high), 0.6)" }} />
          High
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div>
      ) : data ? (
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4 overflow-x-auto">
          <div className="min-w-[500px]">
            {/* Y-axis labels + grid */}
            <div className="flex">
              <div className="w-16 flex-shrink-0" />
              <div className="flex-1 grid" style={{ gridTemplateColumns: `repeat(${data.x_labels.length}, minmax(60px, 1fr))` }}>
                {data.x_labels.map((label) => (
                  <div key={label} className="text-[10px] text-[var(--text-muted)] text-center pb-1 truncate px-0.5">
                    {label}
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-0.5">
              {data.y_labels.map((yLabel) => (
                <div key={yLabel} className="flex items-center">
                  <div className="w-16 text-[10px] text-[var(--text-muted)] text-right pr-2 flex-shrink-0">
                    {yLabel}
                  </div>
                  <div className="flex-1 grid gap-0.5" style={{ gridTemplateColumns: `repeat(${data.x_labels.length}, minmax(60px, 1fr))` }}>
                    {data.x_labels.map((xLabel) => {
                      const value = bucketMap.get(`${xLabel}|${yLabel}`) ?? 0;
                      return (
                        <div
                          key={`${xLabel}-${yLabel}`}
                          className="h-8 rounded flex items-center justify-center text-[9px] font-medium text-[var(--text-secondary)]"
                          style={{ backgroundColor: getColor(value) }}
                          title={`${xLabel} @ ${yLabel}: ${value.toFixed(2)}`}
                        >
                          {value > 0 ? value.toFixed(0) : ""}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Compare Tab
// ──────────────────────────────────────────────────────────────────────────

function CompareTab({
  envTraceId,
  prodTraceId,
  onEnvChange,
  onProdChange,
  onCompare,
  result,
  loading,
}: {
  envTraceId: string;
  prodTraceId: string;
  onEnvChange: (v: string) => void;
  onProdChange: (v: string) => void;
  onCompare: () => void;
  result: ComparativeData | null;
  loading: boolean;
}) {
  return (
    <div className="space-y-6">
      {/* Inputs */}
      <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4 flex items-center gap-2">
          <GitCompare className="w-4 h-4 text-[var(--accent)]" />
          Compare Traces
        </h3>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Environment Trace ID</label>
            <input
              type="text"
              value={envTraceId}
              onChange={(e) => onEnvChange(e.target.value)}
              placeholder="Enter environment trace ID..."
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Production Trace ID</label>
            <input
              type="text"
              value={prodTraceId}
              onChange={(e) => onProdChange(e.target.value)}
              placeholder="Enter production trace ID..."
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </div>
        </div>
        <button
          onClick={onCompare}
          disabled={loading || !envTraceId || !prodTraceId}
          className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitCompare className="w-4 h-4" />}
          Compare
        </button>
      </div>

      {/* Results */}
      {result && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          {/* Overall Score */}
          <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Overall Similarity Score</h3>
              <span className={cn(
                "text-2xl font-bold",
                result.overall_score > 0.7 ? "text-[var(--terminal)]" :
                result.overall_score > 0.4 ? "text-[var(--warning)]" :
                "text-[var(--error)]"
              )}>
                {(result.overall_score * 100).toFixed(1)}%
              </span>
            </div>
            <div className="h-3 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-500",
                  result.overall_score > 0.7 ? "bg-[var(--terminal)]" :
                  result.overall_score > 0.4 ? "bg-[var(--warning)]" :
                  "bg-[var(--error)]"
                )}
                style={{ width: `${result.overall_score * 100}%` }}
              />
            </div>
          </div>

          {/* Dimensions */}
          <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4">Dimension Comparison</h3>
            <div className="space-y-3">
              {result.dimensions.map((dim) => (
                <div key={dim.name} className="p-3 rounded-lg bg-[var(--bg-secondary)]">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-[var(--text-primary)] capitalize">
                      {dim.name.replace(/_/g, " ")}
                    </span>
                    <SeverityBadge severity={dim.severity} />
                  </div>
                  <div className="grid grid-cols-2 gap-4 mb-2">
                    <div>
                      <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">Environment</p>
                      <p className="text-sm font-medium text-[var(--text-primary)]">
                        {typeof dim.env_value === "number" ? dim.env_value.toFixed(2) : String(dim.env_value)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">Production</p>
                      <p className="text-sm font-medium text-[var(--text-primary)]">
                        {typeof dim.prod_value === "number" ? dim.prod_value.toFixed(2) : String(dim.prod_value)}
                      </p>
                    </div>
                  </div>
                  <div className="h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        dim.gap > 0.5 ? "bg-[var(--error)]" : dim.gap > 0.2 ? "bg-[var(--warning)]" : "bg-[var(--terminal)]"
                      )}
                      style={{ width: `${dim.gap * 100}%` }}
                    />
                  </div>
                  <p className="text-xs text-[var(--text-muted)] mt-1">{dim.explanation}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Recommendations */}
          {result.recommendations.length > 0 && (
            <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Recommendations</h3>
              <ul className="space-y-2">
                {result.recommendations.map((rec, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
                    <ChevronRight className="w-3.5 h-3.5 text-[var(--accent)] mt-0.5 flex-shrink-0" />
                    {rec}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </motion.div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function OutcomeBadge({ outcome }: { outcome: string | null }) {
  const classes: Record<string, string> = {
    success: "bg-[var(--terminal-faint)] text-[var(--terminal)]",
    failure: "bg-[var(--error-bg)] text-[var(--error)]",
    partial: "bg-[var(--warning-bg)] text-[var(--warning)]",
    timeout: "bg-[var(--cat-warning-dim)] text-[var(--cat-warning-fg)]",
    crash: "bg-[var(--error-dim)] text-[var(--error)]",
  };
  return (
    <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", classes[outcome || ""] || "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]")}>
      {outcome || "unknown"}
    </span>
  );
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
