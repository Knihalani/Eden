"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronLeft,
  Play,
  Pause,
  RotateCcw,
  Clock,
  Activity,
  Zap,
  AlertCircle,
  CheckCircle2,
  XCircle,
  MessageSquare,
  Code2,
  GitCommit,
  SkipForward,
  SkipBack,
  Layers,
  Loader2,
  Filter,
  BarChart3,
  List,
  Network,
  Terminal,
} from "lucide-react";

interface TraceEvent {
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

type ViewMode = "timeline" | "tree" | "raw";

const EVENT_TYPE_CONFIG: Record<string, { icon: typeof Activity; color: string; label: string }> = {
  "hilt.command": { icon: Terminal, color: "text-[var(--warning)]", label: "HILT" },
  "pipeline.job_failed": { icon: XCircle, color: "text-[var(--error)]", label: "Failure" },
  "job_start": { icon: Play, color: "text-[var(--terminal)]", label: "Start" },
  "job_complete": { icon: CheckCircle2, color: "text-[var(--terminal)]", label: "Complete" },
  "agent.message": { icon: MessageSquare, color: "text-[var(--cat-info-fg)]", label: "Agent" },
  "agent.tool_result": { icon: Zap, color: "text-[var(--cat-purple-fg)]", label: "Tool" },
  "code.fragment": { icon: Code2, color: "text-teal-400", label: "Code" },
  "stage_change": { icon: GitCommit, color: "text-[var(--warning)]", label: "Stage" },
  "trace_event": { icon: Activity, color: "text-[var(--text-muted)]", label: "Trace" },
};

function getEventConfig(eventType: string) {
  return EVENT_TYPE_CONFIG[eventType] || { icon: Activity, color: "text-[var(--text-muted)]", label: eventType };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = ((ms % 60000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  } catch {
    return ts;
  }
}

export default function TraceReplayPage() {
  const params = useParams();
  const router = useRouter();
  const jobId = params.job_id as string;

  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [summary, setSummary] = useState<TraceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("timeline");
  const [selectedEvent, setSelectedEvent] = useState<TraceEvent | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackIndex, setPlaybackIndex] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [filterType, setFilterType] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  const fetchTrace = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.getTraceReplay(jobId, 0, 2000);
      setEvents(data.events);
      if (data.summary) setSummary(data.summary);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load trace");
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    fetchTrace();
  }, [fetchTrace]);

  // Playback timer
  useEffect(() => {
    if (!isPlaying || events.length === 0) return;

    const interval = setInterval(() => {
      setPlaybackIndex((prev) => {
        if (prev >= filteredEvents.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, 500 / playbackSpeed);

    return () => clearInterval(interval);
  }, [isPlaying, events.length, playbackSpeed]);

  const filteredEvents = filterType
    ? events.filter((e) => e.event_type === filterType)
    : events;

  const visibleEvents = isPlaying
    ? filteredEvents.slice(0, playbackIndex + 1)
    : filteredEvents;

  const eventTypes = Array.from(new Set(events.map((e) => e.event_type)));
  const typeCounts = events.reduce((acc, e) => {
    acc[e.event_type] = (acc[e.event_type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const handlePlayPause = () => {
    if (playbackIndex >= filteredEvents.length - 1) {
      setPlaybackIndex(0);
    }
    setIsPlaying(!isPlaying);
  };

  const handleStep = (direction: "forward" | "backward") => {
    setIsPlaying(false);
    setPlaybackIndex((prev) => {
      if (direction === "forward") return Math.min(prev + 1, filteredEvents.length - 1);
      return Math.max(prev - 1, 0);
    });
  };

  const handleReset = () => {
    setIsPlaying(false);
    setPlaybackIndex(0);
  };

  const progressPct = filteredEvents.length > 0
    ? ((playbackIndex + 1) / filteredEvents.length) * 100
    : 0;

  return (
    <div className="min-h-[calc(100vh-3.5rem)] bg-[var(--bg-base)]">
      {/* Header */}
      <div className="border-b border-[var(--border-subtle)]">
        <div className="px-6 py-4">
          <div className="flex items-center gap-3 mb-4">
            <Link
              href={`/jobs/${jobId}`}
              className="p-2 -ml-2 text-[var(--text-faint)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
            >
              <ChevronLeft className="w-5 h-5" />
            </Link>
            <div>
              <h1 className="text-lg font-semibold text-[var(--text-primary)] tracking-tight">Trace Replay</h1>
              <p className="text-sm text-[var(--text-faint)] font-mono">{jobId.slice(0, 8)}</p>
            </div>
          </div>

          {/* Playback Controls */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5 bg-[var(--bg-tertiary)] rounded-lg p-1">
              <button
                onClick={handleReset}
                className="p-2 text-[var(--text-faint)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] rounded-md transition-colors"
                title="Reset"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
              <button
                onClick={() => handleStep("backward")}
                className="p-2 text-[var(--text-faint)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] rounded-md transition-colors"
                title="Step back"
              >
                <SkipBack className="w-4 h-4" />
              </button>
              <button
                onClick={handlePlayPause}
                className="p-2 text-[var(--text-secondary)] hover:text-[var(--bg-base)] bg-[var(--border-subtle)] hover:bg-[var(--border-default)] rounded-md transition-colors"
                title={isPlaying ? "Pause" : "Play"}
              >
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              </button>
              <button
                onClick={() => handleStep("forward")}
                className="p-2 text-[var(--text-faint)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] rounded-md transition-colors"
                title="Step forward"
              >
                <SkipForward className="w-4 h-4" />
              </button>
            </div>

            {/* Speed */}
            <div className="flex items-center gap-1 bg-[var(--bg-tertiary)] rounded-lg p-1">
              {[0.5, 1, 2, 4].map((speed) => (
                <button
                  key={speed}
                  onClick={() => setPlaybackSpeed(speed)}
                  className={cn(
                    "px-2 py-1.5 text-xs font-medium rounded-md transition-colors",
                    playbackSpeed === speed
                      ? "bg-[var(--border-default)] text-[var(--bg-base)]"
                      : "text-[var(--text-faint)] hover:text-[var(--text-muted)]"
                  )}
                >
                  {speed}x
                </button>
              ))}
            </div>

            {/* Progress */}
            <div className="flex-1 max-w-xs">
              <div className="flex items-center justify-between text-xs text-[var(--text-faint)] mb-1">
                <span>{playbackIndex + 1}</span>
                <span>{filteredEvents.length}</span>
              </div>
              <div className="h-1 bg-[var(--border-subtle)] rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-[var(--terminal)]/80 rounded-full"
                  initial={false}
                  animate={{ width: `${progressPct}%` }}
                  transition={{ duration: 0.15 }}
                />
              </div>
            </div>

            {/* View Mode Toggle */}
            <div className="flex items-center gap-1 bg-[var(--bg-tertiary)] rounded-lg p-1 ml-auto">
              {(["timeline", "tree", "raw"] as ViewMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={cn(
                    "p-2 rounded-md transition-colors",
                    viewMode === mode
                      ? "bg-[var(--border-default)] text-[var(--bg-base)]"
                      : "text-[var(--text-faint)] hover:text-[var(--text-muted)]"
                  )}
                  title={mode.charAt(0).toUpperCase() + mode.slice(1)}
                >
                  {mode === "timeline" && <List className="w-4 h-4" />}
                  {mode === "tree" && <Network className="w-4 h-4" />}
                  {mode === "raw" && <Terminal className="w-4 h-4" />}
                </button>
              ))}
            </div>

            {/* Filter Toggle */}
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={cn(
                "p-2 rounded-lg transition-colors",
                showFilters || filterType
                  ? "bg-[var(--border-default)] text-[var(--bg-base)]"
                  : "text-[var(--text-faint)] hover:text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]"
              )}
              title="Filter events"
            >
              <Filter className="w-4 h-4" />
            </button>
          </div>

          {/* Filter Bar */}
          <AnimatePresence>
            {showFilters && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="flex items-center gap-2 mt-3 flex-wrap">
                  <button
                    onClick={() => setFilterType(null)}
                    className={cn(
                      "px-3 py-1.5 text-xs font-medium rounded-full transition-colors",
                      !filterType
                        ? "bg-[var(--border-default)] text-[var(--bg-base)]"
                        : "bg-[var(--bg-tertiary)] text-[var(--text-faint)] hover:bg-[var(--border-subtle)]"
                    )}
                  >
                    All ({events.length})
                  </button>
                  {eventTypes.map((type) => (
                    <button
                      key={type}
                      onClick={() => setFilterType(filterType === type ? null : type)}
                      className={cn(
                        "px-3 py-1.5 text-xs font-medium rounded-full transition-colors",
                        filterType === type
                          ? "bg-[var(--border-default)] text-[var(--bg-base)]"
                          : "bg-[var(--bg-tertiary)] text-[var(--text-faint)] hover:bg-[var(--border-subtle)]"
                      )}
                    >
                      {getEventConfig(type).label} ({typeCounts[type] || 0})
                    </button>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex">
        {/* Event List */}
        <div className={cn("flex-1 overflow-auto", selectedEvent ? "max-w-[60%]" : "max-w-full")}>
          {loading ? (
            <div className="flex flex-col items-center justify-center h-[60vh] gap-3">
              <Loader2 className="w-6 h-6 text-[var(--text-faint)] animate-spin" />
              <p className="text-sm text-[var(--text-faint)]">Loading trace events...</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-[60vh] gap-3">
              <AlertCircle className="w-8 h-8 text-[var(--error)]/60" />
              <p className="text-sm text-[var(--text-faint)]">{error}</p>
              <button
                onClick={fetchTrace}
                className="text-sm text-[var(--terminal)] hover:text-[var(--terminal)] transition-colors"
              >
                Retry
              </button>
            </div>
          ) : visibleEvents.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No trace events found"
              description="The replay has no events matching the current filter. Try a wider event type or remove the filter."
              size="md"
            />
          ) : (
            <div className="divide-y divide-white/[0.03]">
              {visibleEvents.map((event, index) => {
                const config = getEventConfig(event.event_type);
                const Icon = config.icon;
                const isHighlighted = isPlaying && index === playbackIndex;
                const isSelected = selectedEvent?.event_id === event.event_id;

                return (
                  <motion.div
                    key={event.event_id}
                    initial={isPlaying ? { opacity: 0, x: -8 } : false}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.15 }}
                    onClick={() => setSelectedEvent(event)}
                    className={cn(
                      "flex items-start gap-3 px-6 py-3 cursor-pointer transition-colors group",
                      isHighlighted && "bg-[var(--terminal)]/5",
                      isSelected && "bg-[var(--bg-tertiary)]",
                      !isSelected && !isHighlighted && "hover:bg-[var(--bg-tertiary)]"
                    )}
                  >
                    {/* Sequence + Icon */}
                    <div className="flex flex-col items-center gap-1 pt-0.5">
                      <span className="text-[10px] font-mono text-[var(--text-faint)] tabular-nums">
                        {event.sequence}
                      </span>
                      <div className={cn("p-1.5 rounded-md bg-[var(--bg-tertiary)]", config.color)}>
                        <Icon className="w-3.5 h-3.5" />
                      </div>
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className={cn("text-xs font-medium", config.color)}>
                          {config.label}
                        </span>
                        <span className="text-[10px] text-[var(--text-faint)]">
                          {formatTimestamp(event.timestamp)}
                        </span>
                        {event.priority === "high" && (
                          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-[var(--error)]/10 text-[var(--error)] rounded">
                            HIGH
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-[var(--text-faint)] truncate">
                        {event.payload && typeof event.payload === "object"
                          ? JSON.stringify(event.payload).slice(0, 120)
                          : event.event_type}
                      </p>
                    </div>

                    {/* Expand indicator */}
                    <ChevronLeft
                      className={cn(
                        "w-4 h-4 text-[var(--text-faint)] group-hover:text-[var(--text-faint)] transition-all flex-shrink-0 mt-1",
                        isSelected && "-rotate-90 text-[var(--text-faint)]"
                      )}
                    />
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>

        {/* Event Detail Panel */}
        <AnimatePresence>
          {selectedEvent && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: "40%", opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="border-l border-[var(--border-subtle)] bg-[var(--bg-base)] overflow-auto"
            >
              <div className="p-5">
                <div className="flex items-center justify-between mb-5">
                  <div className="flex items-center gap-2">
                    {(() => {
                      const Config = getEventConfig(selectedEvent.event_type);
                      return <Config.icon className={cn("w-5 h-5", Config.color)} />;
                    })()}
                    <span className="text-sm font-semibold text-[var(--text-secondary)]">
                      Event Details
                    </span>
                  </div>
                  <button
                    onClick={() => setSelectedEvent(null)}
                    className="p-1.5 text-[var(--text-faint)] hover:text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
                  >
                    <XCircle className="w-4 h-4" />
                  </button>
                </div>

                <div className="space-y-3">
                  <DetailRow label="Event ID" value={selectedEvent.event_id} />
                  <DetailRow label="Type" value={selectedEvent.event_type} />
                  <DetailRow label="Sequence" value={String(selectedEvent.sequence)} />
                  <DetailRow label="Timestamp" value={selectedEvent.timestamp} />
                  <DetailRow label="Priority" value={selectedEvent.priority} />
                  <DetailRow label="Version" value={selectedEvent.version} />
                  <DetailRow label="Entity" value={selectedEvent.entity_id} />
                </div>

                <div className="mt-5">
                  <h3 className="text-xs font-semibold text-[var(--text-faint)] uppercase tracking-wider mb-2">
                    Payload
                  </h3>
                  <pre className="p-3 rounded-lg bg-black/40 text-xs text-[var(--text-muted)] overflow-auto max-h-[50vh] font-mono leading-relaxed">
                    {JSON.stringify(selectedEvent.payload, null, 2)}
                  </pre>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Summary Bar */}
      {summary && (
        <div className="fixed bottom-0 left-0 right-0 border-t border-[var(--border-subtle)] bg-[var(--bg-base)]/95 backdrop-blur-sm px-6 py-2.5 flex items-center gap-6 text-xs">
          <div className="flex items-center gap-1.5 text-[var(--text-faint)]">
            <BarChart3 className="w-3.5 h-3.5" />
            <span className="font-medium text-[var(--text-muted)]">{summary.event_count}</span> events
          </div>
          <div className="flex items-center gap-1.5 text-[var(--text-faint)]">
            <Clock className="w-3.5 h-3.5" />
            <span>{formatDuration(summary.duration_ms)}</span>
          </div>
          {Object.entries(summary.types).length > 0 && (
            <div className="flex items-center gap-3 ml-auto">
              {Object.entries(summary.types).slice(0, 5).map(([type, count]) => (
                <span key={type} className="text-[var(--text-faint)]">
                  {getEventConfig(type).label}: <span className="text-[var(--text-faint)]">{count}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-xs text-[var(--text-faint)] flex-shrink-0">{label}</span>
      <span className="text-xs text-[var(--text-muted)] font-mono truncate">{value}</span>
    </div>
  );
}
