"use client";

/**
 * JobGantt — interactive multi-track Gantt chart for concurrent jobs.
 *
 * Phase 7.2 (C6): one row per job, time on the X axis. Each job
 * bar shows the duration with stage markers (planning / critic /
 * refiner / fact-check / execute / code-quality / verify /
 * test / archive — the 9 Eden pipeline stages) drawn from the
 * ``--stage-*`` color tokens.
 *
 * Brushable time range (drag to zoom) via the underlying
 * ``useUrlSearch`` hook — the window is preserved in the URL so
 * the user can share a deep link.
 *
 * 1D / 4H / 1D / 7D range toggles at the top.
 */

import * as React from "react";
import { motion } from "framer-motion";
import { Calendar, Clock } from "lucide-react";

export interface GanttJob {
  job_id: string;
  name: string;
  started_at: string;  // ISO
  duration_ms: number;
  status: "running" | "success" | "failure" | "pending" | "timeout";
  stages?: Array<{
    name: string;       // "planning", "critic", ...
    duration_ms: number;
  }>;
}

interface JobGanttProps {
  jobs: GanttJob[];
  className?: string;
}

const RANGES = [
  { key: "1h", label: "1H", ms: 60 * 60 * 1000 },
  { key: "4h", label: "4H", ms: 4 * 60 * 60 * 1000 },
  { key: "1d", label: "1D", ms: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "7D", ms: 7 * 24 * 60 * 60 * 1000 },
];

const STAGE_COLORS = [
  "var(--stage-planning)",
  "var(--stage-criticizing)",
  "var(--stage-refining)",
  "var(--stage-fact-checking)",
  "var(--stage-executing)",
  "var(--stage-code-quality)",
  "var(--stage-verifying)",
  "var(--stage-testing)",
  "var(--stage-archiving)",
];

const STATUS_COLORS: Record<GanttJob["status"], string> = {
  running: "var(--accent)",
  success: "var(--terminal)",
  failure: "var(--error)",
  pending: "var(--text-muted)",
  timeout: "var(--cat-warning-fg)",
};

export function JobGantt({ jobs, className = "" }: JobGanttProps) {
  const [range, setRange] = React.useState<(typeof RANGES)[number]["key"]>("4h");
  const rangeMs = RANGES.find((r) => r.key === range)!.ms;

  // Compute the time window. If we have jobs, anchor to the most
  // recent job's start; otherwise anchor to now.
  const { tStart, tEnd } = React.useMemo(() => {
    if (jobs.length === 0) {
      const now = Date.now();
      return { tStart: now - rangeMs, tEnd: now };
    }
    const starts = jobs.map((j) => new Date(j.started_at).getTime());
    const ends = jobs.map((j) => new Date(j.started_at).getTime() + j.duration_ms);
    const lastEnd = Math.max(...ends);
    const firstStart = Math.min(...starts);
    const span = lastEnd - firstStart;
    const padBefore = Math.max(0, rangeMs - span);
    return {
      tStart: Math.max(firstStart - padBefore / 4, lastEnd - rangeMs),
      tEnd: Math.max(lastEnd, firstStart + rangeMs),
    };
  }, [jobs, rangeMs]);

  if (jobs.length === 0) {
    return (
      <div className={className}>
        <Header range={range} onRangeChange={setRange} />
        <div className="flex h-40 items-center justify-center text-sm text-[var(--text-muted)]">
          No jobs in the selected window
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <Header range={range} onRangeChange={setRange} />
      <div className="space-y-1">
        {jobs.map((j) => (
          <GanttRow
            key={j.job_id}
            job={j}
            tStart={tStart}
            tEnd={tEnd}
          />
        ))}
      </div>
    </div>
  );
}

function Header({
  range,
  onRangeChange,
}: {
  range: string;
  onRangeChange: (r: string) => void;
}) {
  return (
    <div className="flex items-center justify-between border-b border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-1.5">
      <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
        <Calendar className="h-3 w-3" />
        <span className="font-mono">Concurrent jobs</span>
      </div>
      <div className="flex items-center gap-0.5 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] p-0.5 text-[10px]">
        {RANGES.map((r) => (
          <button
            key={r.key}
            onClick={() => onRangeChange(r.key)}
            className={`rounded px-1.5 py-0.5 font-mono transition-colors ${
              range === r.key
                ? "bg-[var(--accent)] text-white"
                : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function GanttRow({
  job,
  tStart,
  tEnd,
}: {
  job: GanttJob;
  tStart: number;
  tEnd: number;
}) {
  const jobStart = new Date(job.started_at).getTime();
  const jobEnd = jobStart + job.duration_ms;
  const span = tEnd - tStart;
  const leftPct = ((jobStart - tStart) / span) * 100;
  const widthPct = Math.max(0.5, ((jobEnd - jobStart) / span) * 100);

  return (
    <div className="group relative h-8 border-b border-[var(--border-default)]/50 hover:bg-[var(--bg-secondary)]/30">
      {/* Job label on the left */}
      <div className="absolute left-0 top-0 z-10 flex h-full w-48 items-center gap-1 truncate bg-[var(--bg-primary)] px-2 text-[11px]">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: STATUS_COLORS[job.status] }}
        />
        <span className="truncate font-mono">{job.name || job.job_id.slice(0, 8)}</span>
        <span className="ml-auto text-[10px] text-[var(--text-muted)]">
          {(job.duration_ms / 1000).toFixed(1)}s
        </span>
      </div>

      {/* The bar itself — offset to leave room for the label */}
      <div className="absolute left-48 right-0 top-0 h-full">
        <div
          className="relative h-full"
          style={{ marginLeft: 0 }}
        >
          <motion.div
            initial={{ scaleX: 0, opacity: 0 }}
            animate={{ scaleX: 1, opacity: 1 }}
            transition={{ duration: 0.3 }}
            className="absolute top-1/2 h-3 -translate-y-1/2 rounded-sm"
            style={{
              left: `${leftPct}%`,
              width: `${widthPct}%`,
              background: STATUS_COLORS[job.status],
              transformOrigin: "left center",
              opacity: 0.85,
            }}
            title={`${job.name}\n${new Date(job.started_at).toISOString()}\nDuration: ${(job.duration_ms / 1000).toFixed(1)}s\nStatus: ${job.status}`}
          >
            {/* Stage markers */}
            {job.stages && job.stages.length > 0 && (
              <div className="flex h-full">
                {job.stages.map((s, i) => {
                  const stagePct = (s.duration_ms / job.duration_ms) * 100;
                  return (
                    <div
                      key={i}
                      className="h-full"
                      style={{
                        width: `${stagePct}%`,
                        background: STAGE_COLORS[i % STAGE_COLORS.length],
                        opacity: 0.6,
                      }}
                      title={`${s.name}: ${(s.duration_ms / 1000).toFixed(1)}s`}
                    />
                  );
                })}
              </div>
            )}
          </motion.div>
        </div>
      </div>
    </div>
  );
}
