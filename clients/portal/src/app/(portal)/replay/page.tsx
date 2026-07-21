"use client";

import { useState, useEffect, useCallback, useRef, useMemo, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { PageContent } from "@/components/layout/page-content";
import {
  ObserveBackToTraces,
  ObserveLeafHeader,
  WAVE10_POWER_ATTR,
  WAVE_V3_8_POWER_ATTR,
} from "@/app/(portal)/observability/_components/observe-leaf-shell";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { errorFromCaught } from "@/lib/safe-error-message";
import { History, Layers, BarChart3, Search } from "lucide-react";
import {
  buildSessions,
  type TabKey,
  type TraceEventItem,
  type TracePickerItem,
  type TraceSummary,
} from "./_components/replay-types";
import { SessionTreeView } from "./_components/session-tree-view";
import { ReplayTimeline } from "./_components/replay-timeline";
import { ReplayEvents } from "./_components/replay-events";

function ReplayPageInner() {
  const { currentOrg } = useOrg();
  const searchParams = useSearchParams();
  const deepLinkJobId =
    searchParams.get("job_id") ?? searchParams.get("trace_id") ?? "";
  const [traces, setTraces] = useState<TracePickerItem[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string>(deepLinkJobId);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("timeline");
  const [traceEvents, setTraceEvents] = useState<TraceEventItem[]>([]);
  const [traceSummary, setTraceSummary] = useState<TraceSummary | null>(null);
  const [loadingTrace, setLoadingTrace] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);
  const eventListRef = useRef<HTMLDivElement>(null);

  const fetchJobs = useCallback(async () => {
    if (!currentOrg?.id) {
      setLoadingJobs(false);
      return;
    }
    setLoadingJobs(true);
    setError(null);
    try {
      const data = await api.listObservabilityTraces(currentOrg.id, {
        limit: 100,
        days: 7,
      });
      const flattened: TracePickerItem[] = data.traces.map((t) => ({
        job_id: t.trace_id,
        status: t.outcome ?? "unknown",
        current_stage: t.realm ?? "",
        outcome_tier: null,
        created_at: t.started_at ?? new Date().toISOString(),
        updated_at: t.started_at ?? new Date().toISOString(),
        agent_id: t.agent_id ?? null,
        session_id: t.session_id ?? null,
        user_id: (t as { user_id?: string | null }).user_id ?? null,
      }));
      setTraces(flattened);
      if (data.traces.length > 0 && !selectedJobId) {
        setSelectedJobId(data.traces[0].trace_id);
      }
    } catch (e) {
      setTraces([]);
      setError(errorFromCaught(e, "Failed to load traces"));
    } finally {
      setLoadingJobs(false);
    }
  }, [currentOrg?.id, selectedJobId]);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  const fetchTrace = useCallback(async () => {
    if (!selectedJobId || !currentOrg?.id) return;
    setLoadingTrace(true);
    setTraceError(null);
    try {
      const [replayData, summaryData] = await Promise.all([
        api.getTraceReplay(currentOrg.id, selectedJobId, 0, 500),
        api.getTraceSummary(currentOrg.id, selectedJobId),
      ]);
      setTraceEvents(replayData.events);
      setTraceSummary(summaryData);
    } catch (e) {
      setTraceError(errorFromCaught(e, "Trace load failed"));
      setTraceEvents([]);
      setTraceSummary(null);
    } finally {
      setLoadingTrace(false);
    }
  }, [currentOrg?.id, selectedJobId]);

  useEffect(() => {
    fetchTrace();
  }, [fetchTrace]);

  const selectedJob = traces.find((j) => j.job_id === selectedJobId);
  const sessions = useMemo(() => buildSessions(traces), [traces]);
  const activeSessionIndex = useMemo(
    () => sessions.findIndex((s) => s.trace_ids.includes(selectedJobId)),
    [sessions, selectedJobId],
  );
  const typeDistribution = traceEvents.reduce(
    (acc, e) => {
      acc[e.event_type] = (acc[e.event_type] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  const totalEvents = traceEvents.length;

  if (!currentOrg) {
    return <NoOrgState feature="Replay" icon={History} />;
  }

  return (
    <PageContent>
      <div
        {...WAVE10_POWER_ATTR}
        {...WAVE_V3_8_POWER_ATTR}
        className="contents"
      >
        <ObserveBackToTraces />
        <ObserveLeafHeader
          title="Replay"
          subtitle="Event timeline for one trace — open from Traces More"
          icon={History}
        />
      </div>

      {sessions.length > 1 && (
        <SessionTreeView
          sessions={sessions}
          pickerItems={traces}
          selectedTraceId={selectedJobId}
          activeSessionIndex={activeSessionIndex}
          onSelect={(traceId) => setSelectedJobId(traceId)}
        />
      )}

      <div className="min-w-[260px] mb-6">
        <label
          className="text-xs text-[var(--text-muted)] mb-1.5 block font-medium"
          htmlFor="replay-job"
        >
          Select Job
        </label>
        <div className="relative">
          <Search
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]"
            aria-hidden
          />
          <select
            id="replay-job"
            value={selectedJobId}
            onChange={(e) => setSelectedJobId(e.target.value)}
            className="w-full pl-8 pr-3 py-2 text-sm bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)] appearance-none cursor-pointer"
          >
            {loadingJobs ? (
              <option>Loading traces...</option>
            ) : error ? (
              <option>Couldn&apos;t load traces</option>
            ) : traces.length === 0 ? (
              <option>No traces found</option>
            ) : (
              traces.map((job) => (
                <option key={job.job_id} value={job.job_id}>
                  {job.job_id.slice(0, 12)}… — {job.status} —{" "}
                  {job.current_stage}
                </option>
              ))
            )}
          </select>
        </div>
        {selectedJob && (
          <div className="flex items-center gap-2 mt-1.5">
            <span
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded font-medium uppercase",
                selectedJob.status === "completed"
                  ? "bg-[var(--terminal)]/10 text-[var(--terminal)]"
                  : selectedJob.status === "failed"
                    ? "bg-[var(--error)]/10 text-[var(--error)]"
                    : selectedJob.status === "running"
                      ? "bg-[var(--warning)]/10 text-[var(--warning)]"
                      : "bg-[var(--bg-tertiary)] text-[var(--text-muted)]",
              )}
            >
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

      {error ? (
        <ErrorState
          title="Couldn't load traces"
          message={error}
          size="sm"
          action={
            <button
              type="button"
              onClick={fetchJobs}
              className="text-sm font-medium text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
            >
              Try again
            </button>
          }
        />
      ) : (
        <>
          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as TabKey)}
            className="mb-6"
          >
            <TabsList
              variant="underline"
              aria-label="Replay view"
              className="h-auto justify-start gap-1 bg-transparent"
            >
              <TabsTrigger
                variant="underline"
                value="timeline"
                className="min-h-11 gap-1.5"
              >
                <BarChart3 className="w-3.5 h-3.5" />
                Timeline
              </TabsTrigger>
              <TabsTrigger
                variant="underline"
                value="events"
                className="min-h-11 gap-1.5"
              >
                <Layers className="w-3.5 h-3.5" />
                Events ({totalEvents})
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {activeTab === "timeline" && (
            <ReplayTimeline
              loadingTrace={loadingTrace}
              traceError={traceError}
              traceSummary={traceSummary}
              typeDistribution={typeDistribution}
              totalEvents={totalEvents}
              onRetry={fetchTrace}
            />
          )}

          {activeTab === "events" && (
            <ReplayEvents
              loadingTrace={loadingTrace}
              traceError={traceError}
              traceEvents={traceEvents}
              expandedEvent={expandedEvent}
              onExpand={setExpandedEvent}
              onRetry={fetchTrace}
              listRef={eventListRef}
            />
          )}
        </>
      )}
    </PageContent>
  );
}

export default function ReplayPage() {
  return (
    <Suspense fallback={<LoadingSkeleton variant="default" />}>
      <ReplayPageInner />
    </Suspense>
  );
}
