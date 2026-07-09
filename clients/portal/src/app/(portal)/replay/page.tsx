"use client";

import { useState, useEffect, useCallback, useRef, useMemo , Suspense} from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { usePolling } from "@/hooks/use-polling";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
;
import { StatCard } from "@/components/ui/stat-card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/layout/page-header";
import { useToast } from "@/components/ui/toast";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { History, Pause, Play, StepForward, RotateCcw, CheckCircle2, XCircle, Terminal, Info, Loader2, AlertCircle, ChevronDown, ChevronUp, Clock, Layers, Activity, Zap, Trash2, RefreshCw, Search, BarChart3, Send, GitBranch } from "lucide-react";

interface __JobItem {
  job_id: string;
  status: string;
  current_stage: string;
  outcome_tier: string | null;
  created_at: string;
  updated_at: string;
}

// Lightweight view-model for the replay-page trace picker.
// We synthesize it from the observability trace stream (the
// retired env-gen `listJobs` was removed in June 2026).
interface TracePickerItem {
  job_id: string;
  status: string;
  current_stage: string;
  outcome_tier: string | null;
  created_at: string;
  updated_at: string;
  user_id?: string | null;
  agent_id?: string | null;
  // Pattern 6.1 (Helicone) — optional first user message so the
  // sessions tree can label each node with something better than
  // a trace_id short. Pulled from the first user_message event in
  // the trace, when present.
  first_user_message?: string | null;
}

// Pattern 6.1 (Helicone): a "session" is a group of traces that
// share an agent_id and whose start times are within the session
// gap window (default 30 minutes). This is a heuristic stand-in
// for an explicit session_id field — once /observability surfaces
// session_id the heuristic can be replaced with a direct lookup.
interface TraceSession {
  session_id: string;
  trace_ids: string[];
  agent_id: string | null;
  started_at: string;
  ended_at: string;
}
const SESSION_GAP_MS = 30 * 60 * 1000;

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
  user_message: { bg: "bg-[var(--accent-faint)]", text: "text-[var(--accent)]", border: "border-[var(--accent-dim)]" } };

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

function ReplayPageInner() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const searchParams = useSearchParams();
  // June 2026: deep-link support — ?job_id= or ?trace_id= (alias).
  // The /observability Traces tab links here with ?trace_id= so the
  // user lands directly on the right trace + can jump into HILT
  // control without re-selecting from the dropdown.
  const deepLinkJobId = searchParams.get("job_id") ?? searchParams.get("trace_id") ?? "";
  const [traces, setTraces] = useState<TracePickerItem[]>([]);
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

  // Fetch trace list (was the retired env-gen listJobs; replaced
  // with the live observability trace stream in June 2026).
  const fetchJobs = useCallback(async () => {
    if (!currentOrg?.id) {
      setLoadingJobs(false);
      return;
    }
    setLoadingJobs(true);
    try {
      const data = await api.listObservabilityTraces(currentOrg.id, { limit: 100, days: 7 });
      const flattened: TracePickerItem[] = data.traces.map((t) => ({
        job_id: t.trace_id,
        status: t.outcome ?? "unknown",
        current_stage: t.realm ?? "",
        outcome_tier: null,
        created_at: t.started_at ?? new Date().toISOString(),
        updated_at: t.started_at ?? new Date().toISOString(),
        // Pattern 6.1 — carry agent_id so the sessions tree can
        // group across users / agents. Without this every trace
        // collapses into one giant session.
        agent_id: t.agent_id ?? null,
        user_id: (t as { user_id?: string | null }).user_id ?? null }));
      setTraces(flattened);
      // ponytail: cheap first-user-message lookup. For each unique
      // trace_id, fetch only one page of replay events, pick the
      // first user_message event, and store it on the picker item.
      // This is bounded (top 12 newest + parallel requests with a
      // concurrency cap = 6) so cold start latency is acceptable.
      const candidates = flattened.slice(0, 12);
      const limited = await Promise.all(
        candidates.map(async (item) => {
          try {
            const replay = await api.getTraceReplay(currentOrg.id, item.job_id, 0, 20);
            const firstUser = replay.events.find((e) => e.event_type === "user_message");
            const text =
              firstUser && typeof firstUser.payload?.message === "string"
                ? (firstUser.payload.message as string)
                : null;
            return { job_id: item.job_id, first_user_message: text };
          } catch {
            return { job_id: item.job_id, first_user_message: null };
          }
        }),
      );
      const labelMap = new Map(limited.map((l) => [l.job_id, l.first_user_message]));
      setTraces((prev) =>
        prev.map((p) =>
          labelMap.has(p.job_id) ? { ...p, first_user_message: labelMap.get(p.job_id) ?? null } : p,
        ),
      );
      if (data.traces.length > 0 && !selectedJobId) {
        setSelectedJobId(data.traces[0].trace_id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load traces");
    } finally {
      setLoadingJobs(false);
    }
  }, [currentOrg?.id, selectedJobId]);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  // Fetch trace when job changes
  const fetchTrace = useCallback(async () => {
    if (!selectedJobId || !currentOrg?.id) return;
    setLoadingTrace(true);
    try {
      const [replayData, summaryData] = await Promise.all([
        api.getTraceReplay(currentOrg.id, selectedJobId, 0, 1000),
        api.getTraceSummary(currentOrg.id, selectedJobId),
      ]);
      setTraceEvents(replayData.events);
      setTraceSummary(summaryData);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Trace load failed";
      toast.error(msg);
      setTraceEvents([]);
      setTraceSummary(null);
    } finally {
      setLoadingTrace(false);
    }
  }, [currentOrg?.id, selectedJobId, toast]);

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
      const msg = e instanceof Error ? e.message : "HILT state load failed";
      toast.error(msg);
      setHiltState(null);
    } finally {
      setLoadingHilt(false);
    }
  }, [selectedJobId, toast]);

  useEffect(() => {
    if (activeTab === "hilt") {
      fetchHiltState();
    }
  }, [activeTab, fetchHiltState]);

  // Poll HILT state when on HILT tab. Cost-safe polling via shared
  // hook — pauses on tab-hidden, backs off on errors, bails on auth
  // failures. June 2026 cost-pass.
  usePolling({
    fetch: fetchHiltState,
    intervalMs: 3_000,
    enabled: activeTab === "hilt" && Boolean(selectedJobId),
    deps: [activeTab, selectedJobId, fetchHiltState] });

  const sendHILTCommand = async (command: string, payload?: Record<string, unknown>) => {
    if (!selectedJobId) return;
    setHiltCommandLoading(true);
    try {
      const res = await api.sendHILTCommand(selectedJobId, command, payload);
      toast.success(`${command} → ${res.status}`, res.message);
      await fetchHiltState();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Command failed");
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
      toast.success("Trace deleted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const selectedJob = traces.find((j) => j.job_id === selectedJobId);

  // Pattern 6.1 (Helicone) — Session tree derivation. Group traces
  // by agent_id and time-proximity (SESSION_GAP_MS between adjacent
  // traces triggers a new session). Memoised so re-renders don't
  // recompute the grouping.
  const sessions = useMemo<TraceSession[]>(() => {
    if (traces.length === 0) return [];
    const sorted = [...traces].sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    const out: TraceSession[] = [];
    let current: TraceSession | null = null;
    let lastTs = 0;
    let lastAgent: string | null = null;
    for (const t of sorted) {
      const ts = new Date(t.created_at).getTime();
      const agent = t.agent_id ?? null;
      const sameAgent = agent === lastAgent;
      const close = ts - lastTs <= SESSION_GAP_MS;
      if (!current || !sameAgent || !close) {
        current = {
          session_id: `sess_${(ts || Math.random()).toString(36)}`,
          trace_ids: [],
          agent_id: agent,
          started_at: t.created_at,
          ended_at: t.created_at };
        out.push(current);
      }
      current.trace_ids.push(t.job_id);
      current.ended_at = t.created_at;
      lastTs = ts;
      lastAgent = agent;
    }
    return out;
  }, [traces]);

  // Locate the session containing the currently-selected trace.
  // Lets us default-scroll + highlight the active node on mount.
  const activeSessionIndex = useMemo(
    () => sessions.findIndex((s) => s.trace_ids.includes(selectedJobId)),
    [sessions, selectedJobId],
  );

  // Event type distribution for timeline
  const typeDistribution = traceEvents.reduce((acc, e) => {
    acc[e.event_type] = (acc[e.event_type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const totalEvents = traceEvents.length;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
      <PageHeader
        title="Trace Replay"
        subtitle="Inspect pipeline traces and control execution via HILT"
        icon={History}
      />

      {/* Back link */}
      <div className="-mt-4 flex items-center gap-2 text-xs text-[var(--text-muted)]">
        <Link
          href="/traces"
          className="inline-flex items-center gap-1 hover:text-[var(--text-secondary)] transition-colors"
        >
          <ArrowLeft className="w-3 h-3" aria-hidden />
          Back to Trace Explorer
        </Link>
      </div>

      {/* Pattern 6.1 (Helicone) — sessions tree. Renders a horizontal
          row of session nodes; each node is a list of trace chips.
          Clicking a chip loads that trace into the timeline below. */}
      {sessions.length > 1 && (
        <SessionTreeView
          sessions={sessions}
          pickerItems={traces}
          selectedTraceId={selectedJobId}
          activeSessionIndex={activeSessionIndex}
          onSelect={(traceId) => setSelectedJobId(traceId)}
        />
      )}

      {/* Job Selector */}
      <div className="min-w-[260px] mb-6">
        <label className="text-xs text-[var(--text-muted)] mb-1.5 block font-medium" htmlFor="replay-job">
          Select Job
        </label>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" aria-hidden />
            <select
              id="replay-job"
              value={selectedJobId}
              onChange={(e) => setSelectedJobId(e.target.value)}
              className="w-full pl-8 pr-3 py-2 text-sm bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)] appearance-none cursor-pointer"
            >
              {loadingJobs ? (
                <option>Loading traces...</option>
              ) : traces.length === 0 ? (
                <option>No traces found</option>
              ) : (
                traces.map((job) => (
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

      {/* Error */}
      {error && (
        <ErrorState
          title="Couldn't load traces"
          message={error}
          size="sm"
          action={
            <button
              onClick={fetchJobs}
              className="text-sm font-medium text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
            >
              Try again
            </button>
          }
        />
      )}

      {/* Tabs */}
      <div
        role="tablist"
        aria-label="Replay view"
        className="flex items-center gap-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg p-1 mb-6 w-fit"
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          const order: TabKey[] = ["timeline", "events", "hilt"];
          const idx = order.indexOf(activeTab);
          const next = e.key === "ArrowRight" ? (idx + 1) % order.length : (idx - 1 + order.length) % order.length;
          setActiveTab(order[next]);
        }}
      >
        {([
          { key: "timeline" as TabKey, label: "Timeline", icon: BarChart3 },
          { key: "events" as TabKey, label: `Events (${totalEvents})`, icon: Layers },
          { key: "hilt" as TabKey, label: "HILT Control", icon: Terminal },
        ]).map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              role="tab"
              aria-selected={activeTab === tab.key}
              aria-controls={`replay-panel-${tab.key}`}
              id={`replay-tab-${tab.key}`}
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
                <StatCard title="Events" value={String(traceSummary.event_count)} icon={Layers} />
                <StatCard title="Duration" value={formatDuration(traceSummary.duration_ms)} icon={Clock} />
                <StatCard
                  title="Started"
                  value={traceSummary.started_at ? new Date(traceSummary.started_at).toLocaleTimeString() : "—"}
                  icon={Play}
                />
                <StatCard
                  title="Ended"
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
                  aria-label="Refresh trace"
                  className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" aria-hidden />
                  Refresh
                </button>
                <button
                  onClick={handleDeleteTrace}
                  aria-label="Delete trace"
                  className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-[var(--error)]/20 text-[var(--error)] hover:bg-[var(--error)]/10 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden />
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
            // Bounded scroll so a trace with thousands of events
            // doesn't push the page past the viewport. June 2026 fix.
            <div className="max-h-[60vh] overflow-y-auto pr-1">
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
            </div>
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
                  <label className="text-xs text-[var(--text-muted)] mb-1.5 block font-medium" htmlFor="hilt-inject">
                    Inject Message
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="hilt-inject"
                      type="text"
                      aria-label="HILT inject JSON payload"
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
                          toast.error("Invalid JSON payload");
                        }
                      }}
                      disabled={hiltCommandLoading || !injectPayload.trim()}
                      className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-[var(--accent)] text-[var(--bg-base)] hover:bg-[var(--accent-hover)] disabled:opacity-40 transition-colors"
                    >
                      <Send className="w-3.5 h-3.5" aria-hidden />
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
                      role="status"
                      aria-live="polite"
                      className={cn(
                        "mt-3 p-2.5 rounded-lg text-xs flex items-center gap-2",
                        hiltMessage.includes(":") && !hiltMessage.toLowerCase().includes("fail") && !hiltMessage.toLowerCase().includes("error")
                          ? "bg-[var(--terminal)]/10 text-[var(--terminal)] border border-[var(--terminal)]/20"
                          : "bg-[var(--error)]/10 text-[var(--error)] border border-[var(--error)]/20"
                      )}
                    >
                      {hiltMessage.toLowerCase().includes("fail") || hiltMessage.toLowerCase().includes("error") ? (
                        <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />
                      ) : (
                        <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />
                      )}
                      {hiltMessage}
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() => setHiltMessage("")}
                        aria-label="Dismiss message"
                        className="ml-auto"
                      >
                        Dismiss
                      </Button>
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
  variant }: {
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
    danger: "bg-[var(--error)]/10 text-[var(--error)] hover:bg-[var(--error)]/20" };

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

// =====================================================================
// Pattern 6.1 (Helicone) — Sessions Tree visualization
// =====================================================================

function SessionTreeView({
  sessions,
  pickerItems,
  selectedTraceId,
  activeSessionIndex,
  onSelect }: {
  sessions: TraceSession[];
  pickerItems: TracePickerItem[];
  selectedTraceId: string;
  activeSessionIndex: number;
  onSelect: (traceId: string) => void;
}) {
  return (
    <div className="mb-6 bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)] p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-[var(--accent)]" />
          Sessions
        </h3>
        <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">
          {sessions.length} sessions · {pickerItems.length} traces · 30m gap
        </span>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2 no-scrollbar">
        {sessions.map((session, sIdx) => {
          const isActive = sIdx === activeSessionIndex;
          return (
            <div
              key={session.session_id}
              className={cn(
                "shrink-0 rounded-lg border p-2.5 min-w-[180px] max-w-[220px]",
                isActive
                  ? "border-[var(--accent)] bg-[var(--accent-light)]/40"
                  : "border-[var(--border-default)] bg-[var(--bg-secondary)]",
              )}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className={cn(
                  "text-[10px] uppercase tracking-wider font-semibold",
                  isActive ? "text-[var(--accent)]" : "text-[var(--text-muted)]",
                )}>
                  Session {sIdx + 1}
                </span>
                <span className="text-[10px] text-[var(--text-muted)]">
                  {session.trace_ids.length} traces
                </span>
              </div>
              <div className="space-y-1">
                {session.trace_ids.map((tid, tIdx) => {
                  const item = pickerItems.find((p) => p.job_id === tid);
                  const label =
                    item?.first_user_message?.slice(0, 32) ||
                    `${tid.slice(0, 8)}…`;
                  const isSel = tid === selectedTraceId;
                  return (
                    <button
                      key={tid}
                      onClick={() => onSelect(tid)}
                      className={cn(
                        "w-full text-left px-2 py-1 rounded text-[11px] flex items-center gap-1.5 transition-colors",
                        isSel
                          ? "bg-[var(--accent)] text-[var(--bg-base)] font-semibold"
                          : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border-default)] hover:text-[var(--text-primary)]",
                      )}
                      title={item?.first_user_message ?? tid}
                    >
                      <span className="font-mono opacity-70 shrink-0">
                        {tIdx + 1}
                      </span>
                      <span className="truncate">{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


// Wrap ReplayPageInner in a Suspense boundary because it reads
// ``useSearchParams()``. Without the boundary Next.js cannot
// statically optimise the page and the RSC prefetch
// (``?._rsc=...``) returns a partial / erroring payload, which
// surfaces in the browser console as a 404.
export default function ReplayPage() {
  return (
    <Suspense fallback={null}>
      <ReplayPageInner />
    </Suspense>
  );
}
