"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/format";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import { motion, AnimatePresence } from "framer-motion";
import {
  PlayCircle,
  History,
  Pause,
  Play,
  StepForward,
  RotateCcw,
  CheckCircle2,
  XCircle,
  Terminal,
  Info,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Clock,
  Layers,
  Activity,
  Zap,
  Trash2,
  RefreshCw,
  Filter,
  Search,
  Download,
  BarChart3,
  MessageSquare,
  Send,
} from "lucide-react";

interface JobItem {
  job_id: string;
  status: string;
  current_stage: string;
  outcome_tier: string | null;
  created_at: string;
  updated_at: string;
}

interface TraceEventItem {
  event_id: string;
  event_type: string;
  timestamp: string;
  sequence: number;
  tenant_id: string;
  user_id: string;
  entity_id: string;
  priority: string;
  payload: Record<string, unknown>;
  version: string;
}

interface TraceSummary {
  event_count: number;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  types: Record<string, number>;
}

interface HILTState {
  job_id: string;
  state: string;
  paused_at: string | null;
  resumed_at: string | null;
  waiting_for: string | null;
  current_step: number | null;
  total_steps: number | null;
  pending_command_count: number;
  history: Array<Record<string, unknown>>;
  last_updated: string;
}

type TabKey = "timeline" | "events" | "hilt";

const EVENT_TYPE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  agent_thought: { bg: "bg-[var(--cat-purple-dim)]", text: "text-[var(--cat-purple-fg)]", border: "border-[var(--cat-purple-fg)]/20" },
  tool_call: { bg: "bg-[var(--cat-info-dim)]", text: "text-[var(--cat-info-fg)]", border: "border-[var(--cat-info-fg)]/20" },
  tool_result: { bg: "bg-[var(--terminal)]/10", text: "text-[var(--terminal)]", border: "border-[var(--terminal)]/20" },
  stage_transition: { bg: "bg-[var(--warning)]/10", text: "text-[var(--warning)]", border: "border-[var(--warning)]/20" },
  error: { bg: "bg-[var(--error)]/10", text: "text-[var(--error)]", border: "border-[var(--error)]/20" },
  system: { bg: "bg-[var(--bg-tertiary)]", text: "text-[var(--text-muted)]", border: "border-[var(--border-default)]" },
  user_message: { bg: "bg-[var(--accent-faint)]", text: "text-[var(--accent)]", border: "border-[var(--accent-dim)]" },
};

function getEventTypeColor(eventType: string) {
  return EVENT_TYPE_COLORS[eventType] || EVENT_TYPE_COLORS.system;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString() + "." + String(d.getMilliseconds()).padStart(3, "0");
}

export default function ReplayPage() {
  const { currentOrg } = useOrg();
  const searchParams = useSearchParams();
  // June 2026: deep-link support — ?job_id= or ?trace_id= (alias).
  // The /observability Traces tab links here with ?trace_id= so the
  // user lands directly on the right trace + can jump into HILT
  // control without re-selecting from the dropdown.
  const deepLinkJobId = searchParams.get("job_id") ?? searchParams.get("trace_id") ?? "";
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string>(deepLinkJobId);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<TabKey>("timeline");

  // Trace state
  const [traceEvents, setTraceEvents] = useState<TraceEventItem[]>([]);
  const [traceSummary, setTraceSummary] = useState<TraceSummary | null>(null);
  const [loadingTrace, setLoadingTrace] = useState(false);
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);

  // HILT state
  const [hiltState, setHiltState] = useState<HILTState | null>(null);
  const [loadingHilt, setLoadingHilt] = useState(false);
  const [hiltCommandLoading, setHiltCommandLoading] = useState(false);
  const [hiltMessage, setHiltMessage] = useState<string>("");
  const [injectPayload, setInjectPayload] = useState("");

  const eventListRef = useRef<HTMLDivElement>(null);

  // Fetch jobs list
  const fetchJobs = useCallback(async () => {
    setLoadingJobs(true);
    try {
      const data = await api.listJobs({ limit: 100, sort: "-created_at" });
      setJobs(data.jobs);
      if (data.jobs.length > 0 && !selectedJobId) {
        setSelectedJobId(data.jobs[0].job_id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load jobs");
    } finally {
      setLoadingJobs(false);
    }
  }, [selectedJobId]);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  // Fetch trace when job changes
  const fetchTrace = useCallback(async () => {
    if (!selectedJobId) return;
    setLoadingTrace(true);
    try {
      const [replayData, summaryData] = await Promise.all([
        api.getTraceReplay(selectedJobId, 0, 1000),
        api.getTraceSummary(selectedJobId),
      ]);
      setTraceEvents(replayData.events);
      setTraceSummary(summaryData);
    } catch (e) {
      console.error("Trace load failed:", e);
      setTraceEvents([]);
      setTraceSummary(null);
    } finally {
      setLoadingTrace(false);
    }
  }, [selectedJobId]);

  useEffect(() => {
    fetchTrace();
  }, [fetchTrace]);

  // Fetch HILT state
  const fetchHiltState = useCallback(async () => {
    if (!selectedJobId) return;
    setLoadingHilt(true);
    try {
      const state = await api.getHILTState(selectedJobId);
      setHiltState(state);
    } catch (e) {
      console.error("HILT state load failed:", e);
      setHiltState(null);
    } finally {
      setLoadingHilt(false);
    }
  }, [selectedJobId]);

  useEffect(() => {
    if (activeTab === "hilt") {
      fetchHiltState();
    }
  }, [activeTab, fetchHiltState]);

  // Poll HILT state when on HILT tab
  useEffect(() => {
    if (activeTab !== "hilt" || !selectedJobId) return;
    const interval = setInterval(fetchHiltState, 3000);
    return () => clearInterval(interval);
  }, [activeTab, selectedJobId, fetchHiltState]);

  const sendHILTCommand = async (command: string, payload?: Record<string, unknown>) => {
    if (!selectedJobId) return;
    setHiltCommandLoading(true);
    setHiltMessage("");
    try {
      const res = await api.sendHILTCommand(selectedJobId, command, payload);
      setHiltMessage(`${res.status}: ${res.message}`);
      await fetchHiltState();
    } catch (e) {
      setHiltMessage(e instanceof Error ? e.message : "Command failed");
    } finally {
      setHiltCommandLoading(false);
    }
  };

  const handleDeleteTrace = async () => {
    if (!selectedJobId) return;
    if (!confirm("Delete trace for this job? This cannot be undone.")) return;
    try {
      await api.deleteTrace(selectedJobId);
      setTraceEvents([]);
      setTraceSummary(null);
      setHiltMessage("Trace deleted");
    } catch (e) {
      setHiltMessage(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const selectedJob = jobs.find((j) => j.job_id === selectedJobId);

  // Event type distribution for timeline
  const typeDistribution = traceEvents.reduce((acc, e) => {
    acc[e.event_type] = (acc[e.event_type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const totalEvents = traceEvents.length;

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)] tracking-tight flex items-center gap-2">
            <History className="w-6 h-6 text-[var(--accent)]" />
            Trace Replay
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            Inspect pipeline traces and control execution via HILT
          </p>
        </div>

        {/* Job Selector */}
        <div className="min-w-[260px]">
          <label className="text-xs text-[var(--text-muted)] mb-1.5 block font-medium">Select Job</label>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
            <select
              value={selectedJobId}
              onChange={(e) => setSelectedJobId(e.target.value)}
              className="w-full pl-8 pr-3 py-2 text-sm bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)] appearance-none cursor-pointer"
            >
              {loadingJobs ? (
                <option>Loading jobs...</option>
              ) : jobs.length === 0 ? (
                <option>No jobs found</option>
              ) : (
                jobs.map((job) => (
                  <option key={job.job_id} value={job.job_id}>
                    {job.job_id.slice(0, 12)}… — {job.status} — {job.current_stage}
                  </option>
                ))
              )}
            </select>
          </div>
          {selectedJob && (
            <div className="flex items-center gap-2 mt-1.5">
              <span className={cn(
                "text-[10px] px-1.5 py-0.5 rounded font-medium uppercase",
                selectedJob.status === "completed" ? "bg-[var(--terminal)]/10 text-[var(--terminal)]" :
                selectedJob.status === "failed" ? "bg-[var(--error)]/10 text-[var(--error)]" :
                selectedJob.status === "running" ? "bg-[var(--warning)]/10 text-[var(--warning)]" :
                "bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
              )}>
                {selectedJob.status}
              </span>
              <span className="text-[10px] text-[var(--text-muted)]">
                {selectedJob.outcome_tier || "—"}
              </span>
              <span className="text-[10px] text-[var(--text-muted)]">
                {new Date(selectedJob.created_at).toLocaleDateString()}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 rounded-lg border border-[var(--error)]/20 bg-[var(--error)]/10 text-sm text-[var(--error)] flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
          <button onClick={fetchJobs} className="ml-auto text-xs underline">Retry</button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg p-1 mb-6 w-fit">
        {([
          { key: "timeline" as TabKey, label: "Timeline", icon: BarChart3 },
          { key: "events" as TabKey, label: `Events (${totalEvents})`, icon: Layers },
          { key: "hilt" as TabKey, label: "HILT Control", icon: Terminal },
        ]).map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                activeTab === tab.key
                  ? "bg-[var(--accent)] text-[var(--bg-base)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Timeline Tab */}
      {activeTab === "timeline" && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          {loadingTrace ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Loader2 className="w-6 h-6 text-[var(--text-muted)] animate-spin" />
              <p className="text-sm text-[var(--text-muted)]">Loading trace…</p>
            </div>
          ) : !traceSummary ? (
            <EmptyState icon={History} title="No trace data for this job" description="Traces are generated during pipeline execution. Run a job to see its decision trace here." />
          ) : (
            <div className="space-y-4">
              {/* Summary Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard label="Events" value={String(traceSummary.event_count)} icon={Layers} />
                <StatCard label="Duration" value={formatDuration(traceSummary.duration_ms)} icon={Clock} />
                <StatCard
                  label="Started"
                  value={traceSummary.started_at ? new Date(traceSummary.started_at).toLocaleTimeString() : "—"}
                  icon={Play}
                />
                <StatCard
                  label="Ended"
                  value={traceSummary.ended_at ? new Date(traceSummary.ended_at).toLocaleTimeString() : "—"}
                  icon={CheckCircle2}
                />
              </div>

              {/* Event Type Distribution */}
              <div className="bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)] p-4">
                <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
                  <Activity className="w-4 h-4 text-[var(--accent)]" />
                  Event Type Distribution
                </h3>
                {Object.keys(typeDistribution).length === 0 ? (
                  <EmptyState
                    icon={Activity}
                    title="No event distribution"
                    description="This trace has no events to aggregate. Check that the pipeline ran to completion."
                    size="sm"
                  />
                ) : (
                  <div className="space-y-2">
                    {Object.entries(typeDistribution)
                      .sort(([, a], [, b]) => b - a)
                      .map(([type, count]) => {
                        const pct = totalEvents > 0 ? Math.round((count / totalEvents) * 100) : 0;
                        const colors = getEventTypeColor(type);
                        return (
                          <div key={type} className="flex items-center gap-3">
                            <span className={cn("text-xs font-medium w-24 truncate", colors.text)}>{type}</span>
                            <div className="flex-1 h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                              <div
                                className={cn("h-full rounded-full", colors.bg.replace("/10", ""))}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-xs text-[var(--text-muted)] w-12 text-right">{count}</span>
                            <span className="text-xs text-[var(--text-muted)] w-8 text-right">{pct}%</span>
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>

              {/* Quick Actions */}
              <div className="flex items-center gap-2">
                <button
                  onClick={fetchTrace}
                  className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Refresh
                </button>
                <button
                  onClick={handleDeleteTrace}
                  className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-[var(--error)]/20 text-[var(--error)] hover:bg-[var(--error)]/10 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete Trace
                </button>
              </div>
            </div>
          )}
        </motion.div>
      )}

      {/* Events Tab */}
      {activeTab === "events" && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          ref={eventListRef}
          className="space-y-2"
        >
          {loadingTrace ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Loader2 className="w-6 h-6 text-[var(--text-muted)] animate-spin" />
              <p className="text-sm text-[var(--text-muted)]">Loading events…</p>
            </div>
          ) : traceEvents.length === 0 ? (
            <EmptyState icon={Layers} title="No events" description="Select a job with trace data to view its events." />
          ) : (
            <>
              {traceEvents.map((event) => {
                const colors = getEventTypeColor(event.event_type);
                const isExpanded = expandedEvent === event.event_id;
                return (
                  <motion.div
                    key={event.event_id}
                    layout
                    className={cn(
                      "rounded-lg border transition-all bg-[var(--bg-primary)]",
                      isExpanded ? "border-[var(--border-strong)]" : "border-[var(--border-default)] hover:border-[var(--border-strong)]"
                    )}
                  >
                    <button
                      className="w-full flex items-start gap-3 p-3 text-left"
                      onClick={() => setExpandedEvent(isExpanded ? null : event.event_id)}
                    >
                      <div className={cn("p-1.5 rounded-md flex-shrink-0 mt-0.5", colors.bg)}>
                        <Zap className={cn("w-3.5 h-3.5", colors.text)} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={cn("text-xs font-semibold", colors.text)}>{event.event_type}</span>
                          <span className="text-[10px] text-[var(--text-muted)] font-mono">seq {event.sequence}</span>
                          <span className="text-[10px] text-[var(--text-muted)]">{formatTimestamp(event.timestamp)}</span>
                          {event.priority !== "normal" && (
                            <span className={cn(
                              "text-[10px] px-1 rounded font-medium uppercase",
                              event.priority === "high" ? "bg-[var(--error)]/10 text-[var(--error)]" : "bg-[var(--warning)]/10 text-[var(--warning)]"
                            )}>
                              {event.priority}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-[var(--text-muted)] mt-0.5 truncate">
                          {event.entity_id.slice(0, 24)}…
                        </p>
                      </div>
                      <div className="flex-shrink-0 mt-1">
                        {isExpanded ? <ChevronUp className="w-4 h-4 text-[var(--text-muted)]" /> : <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />}
                      </div>
                    </button>

                    <AnimatePresence>
                      {isExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.15 }}
                          className="overflow-hidden"
                        >
                          <div className="px-3 pb-3 pt-0 border-t border-[var(--border-default)]">
                            <div className="pt-3 space-y-2">
                              <DetailRow label="Event ID" value={event.event_id} />
                              <DetailRow label="Sequence" value={String(event.sequence)} />
                              <DetailRow label="Timestamp" value={event.timestamp} />
                              <DetailRow label="Tenant" value={event.tenant_id} />
                              <DetailRow label="User" value={event.user_id} />
                              <DetailRow label="Entity" value={event.entity_id} />
                              <DetailRow label="Version" value={event.version} />
                              <div className="mt-2">
                                <span className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider block mb-1">Payload</span>
                                <pre className="text-[11px] font-mono text-[var(--text-secondary)] bg-[var(--bg-tertiary)] rounded-lg p-2.5 overflow-x-auto whitespace-pre-wrap break-all">
                                  {JSON.stringify(event.payload, null, 2)}
                                </pre>
                              </div>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                );
              })}
            </>
          )}
        </motion.div>
      )}

      {/* HILT Tab */}
      {activeTab === "hilt" && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          {loadingHilt && !hiltState ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Loader2 className="w-6 h-6 text-[var(--text-muted)] animate-spin" />
              <p className="text-sm text-[var(--text-muted)]">Loading HILT state…</p>
            </div>
          ) : !hiltState ? (
            <EmptyState icon={Terminal} title="No HILT state" description="Human-in-the-loop control is only active for jobs that support it. Start a job to interact with the pipeline." />
          ) : (
            <div className="space-y-4">
              {/* Status Card */}
              <div className="bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)] p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-[var(--accent)]" />
                    HILT Status
                  </h3>
                  <span className={cn(
                    "text-[10px] px-2 py-0.5 rounded-full font-bold uppercase",
                    hiltState.state === "paused" ? "bg-[var(--warning)]/10 text-[var(--warning)]" :
                    hiltState.state === "running" ? "bg-[var(--terminal)]/10 text-[var(--terminal)]" :
                    hiltState.state === "waiting" ? "bg-[var(--cat-info-dim)] text-[var(--cat-info-fg)]" :
                    "bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
                  )}>
                    {hiltState.state}
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                  <MiniStat label="Step" value={`${hiltState.current_step ?? "—"} / ${hiltState.total_steps ?? "—"}`} />
                  <MiniStat label="Pending" value={String(hiltState.pending_command_count)} />
                  <MiniStat label="Paused" value={hiltState.paused_at ? new Date(hiltState.paused_at).toLocaleTimeString() : "—"} />
                  <MiniStat label="Updated" value={new Date(hiltState.last_updated).toLocaleTimeString()} />
                </div>

                {hiltState.waiting_for && (
                  <div className="flex items-center gap-2 p-2 rounded-lg bg-[var(--cat-info-dim)] border border-[var(--cat-info-fg)]/10">
                    <Info className="w-3.5 h-3.5 text-[var(--cat-info-fg)] flex-shrink-0" />
                    <span className="text-xs text-[var(--cat-info-fg)]">Waiting for: {hiltState.waiting_for}</span>
                  </div>
                )}
              </div>

              {/* Command Buttons */}
              <div className="bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)] p-4">
                <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Commands</h3>
                <div className="flex flex-wrap gap-2">
                  <HILTButton
                    icon={Pause}
                    label="Pause"
                    onClick={() => sendHILTCommand("pause")}
                    loading={hiltCommandLoading}
                    variant="warning"
                  />
                  <HILTButton
                    icon={Play}
                    label="Resume"
                    onClick={() => sendHILTCommand("resume")}
                    loading={hiltCommandLoading}
                    variant="success"
                  />
                  <HILTButton
                    icon={StepForward}
                    label="Step"
                    onClick={() => sendHILTCommand("step")}
                    loading={hiltCommandLoading}
                    variant="default"
                  />
                  <HILTButton
                    icon={RotateCcw}
                    label="Rewind"
                    onClick={() => sendHILTCommand("rewind")}
                    loading={hiltCommandLoading}
                    variant="default"
                  />
                  <HILTButton
                    icon={CheckCircle2}
                    label="Approve"
                    onClick={() => sendHILTCommand("approve")}
                    loading={hiltCommandLoading}
                    variant="success"
                  />
                  <HILTButton
                    icon={XCircle}
                    label="Reject"
                    onClick={() => sendHILTCommand("reject")}
                    loading={hiltCommandLoading}
                    variant="danger"
                  />
                  <HILTButton
                    icon={RefreshCw}
                    label="Cleanup"
                    onClick={() => sendHILTCommand("cleanup")}
                    loading={hiltCommandLoading}
                    variant="default"
                  />
                </div>

                {/* Inject Message */}
                <div className="mt-4 pt-4 border-t border-[var(--border-default)]">
                  <label className="text-xs text-[var(--text-muted)] mb-1.5 block font-medium">Inject Message</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={injectPayload}
                      onChange={(e) => setInjectPayload(e.target.value)}
                      placeholder='{"message": "..."}'
                      className="flex-1 px-3 py-2 text-sm bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded-lg text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]"
                    />
                    <button
                      onClick={() => {
                        try {
                          const payload = injectPayload ? JSON.parse(injectPayload) : {};
                          sendHILTCommand("inject", payload);
                        } catch {
                          setHiltMessage("Invalid JSON payload");
                        }
                      }}
                      disabled={hiltCommandLoading || !injectPayload.trim()}
                      className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-[var(--accent)] text-[var(--bg-base)] hover:bg-[var(--accent-hover)] disabled:opacity-40 transition-colors"
                    >
                      <Send className="w-3.5 h-3.5" />
                      Inject
                    </button>
                  </div>
                </div>

                {/* Command Result */}
                <AnimatePresence>
                  {hiltMessage && (
                    <motion.div
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      className={cn(
                        "mt-3 p-2.5 rounded-lg text-xs flex items-center gap-2",
                        hiltMessage.includes(":") && !hiltMessage.toLowerCase().includes("fail") && !hiltMessage.toLowerCase().includes("error")
                          ? "bg-[var(--terminal)]/10 text-[var(--terminal)] border border-[var(--terminal)]/20"
                          : "bg-[var(--error)]/10 text-[var(--error)] border border-[var(--error)]/20"
                      )}
                    >
                      {hiltMessage.toLowerCase().includes("fail") || hiltMessage.toLowerCase().includes("error") ? (
                        <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                      ) : (
                        <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
                      )}
                      {hiltMessage}
                      <button
                        onClick={() => setHiltMessage("")}
                        className="ml-auto text-[10px] underline opacity-70 hover:opacity-100"
                      >
                        Dismiss
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Command History */}
              {hiltState.history.length > 0 && (
                <div className="bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)] p-4">
                  <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
                    <History className="w-4 h-4 text-[var(--accent)]" />
                    Command History
                  </h3>
                  <div className="space-y-1.5 max-h-60 overflow-y-auto">
                    {hiltState.history.map((entry, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-2 p-2 rounded-md bg-[var(--bg-tertiary)]/50 text-xs"
                      >
                        <span className="text-[var(--text-muted)] font-mono w-5">{idx + 1}</span>
                        <span className="text-[var(--text-secondary)] font-medium">
                          {String((entry as Record<string, unknown>).command || (entry as Record<string, unknown>).type || "—")}
                        </span>
                        <span className="text-[var(--text-muted)] ml-auto">
                          {entry.timestamp ? new Date(String(entry.timestamp)).toLocaleTimeString() : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </motion.div>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--bg-tertiary)]/50 rounded-md p-2">
      <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider block">{label}</span>
      <span className="text-sm font-semibold text-[var(--text-primary)]">{value}</span>
    </div>
  );
}

function HILTButton({
  icon: Icon,
  label,
  onClick,
  loading,
  variant,
}: {
  icon: typeof Pause;
  label: string;
  onClick: () => void;
  loading: boolean;
  variant: "default" | "warning" | "success" | "danger";
}) {
  const variantClasses = {
    default: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border-default)]",
    warning: "bg-[var(--warning)]/10 text-[var(--warning)] hover:bg-[var(--warning)]/20",
    success: "bg-[var(--terminal)]/10 text-[var(--terminal)] hover:bg-[var(--terminal)]/20",
    danger: "bg-[var(--error)]/10 text-[var(--error)] hover:bg-[var(--error)]/20",
  };

  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={cn(
        "flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors disabled:opacity-40",
        variantClasses[variant]
      )}
    >
      {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
      {label}
    </button>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider flex-shrink-0">{label}</span>
      <span className="text-xs text-[var(--text-secondary)] font-mono truncate">{value}</span>
    </div>
  );
}

// (Local EmptyState deleted; use EmptyState from ui/empty-state)
