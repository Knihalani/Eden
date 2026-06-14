"use client";

import Link from "next/link";
import { Loader2, GitBranch, ArrowRight, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TraceRow {
  trace_id: string;
  agent_id: string | null;
  outcome: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  span_count: number;
  realm: string;
}

interface RecentTracesCardProps {
  loading: boolean;
  traces: TraceRow[];
}

export function RecentTracesCard({ loading, traces }: RecentTracesCardProps) {
  const top = traces.slice(0, 10);
  const empty = !loading && top.length === 0;

  return (
    <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)]">
      <div className="flex items-center justify-between p-5 pb-3">
        <div>
          <h2 className="text-base font-semibold text-[var(--text-primary)]">Recent Traces</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">last 10 — click for tree view</p>
        </div>
        <Link
          href="/observability"
          className="text-xs font-medium text-[var(--accent)] hover:text-[var(--accent-hover)] inline-flex items-center gap-1"
        >
          View all
          <ArrowRight className="w-3 h-3" />
        </Link>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" />
        </div>
      ) : empty ? (
        <div className="text-center py-10 px-5">
          <GitBranch className="w-8 h-8 mx-auto mb-3 text-[var(--text-muted)] stroke-1 opacity-60" />
          <p className="text-sm text-[var(--text-secondary)]">No traces yet</p>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Traces will appear here once your agents emit telemetry.
          </p>
          <Link
            href="/observability"
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:text-[var(--accent-hover)]"
          >
            Open observability
            <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border-subtle)]">
          {top.map((t) => (
            <li key={t.trace_id}>
              <Link
                href={`/observability?trace=${encodeURIComponent(t.trace_id)}`}
                className="flex items-center gap-3 px-5 py-2.5 hover:bg-[var(--bg-secondary)] transition-colors group"
              >
                <OutcomeDot outcome={t.outcome} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono text-[var(--text-primary)] truncate">
                    {t.trace_id.slice(0, 16)}
                  </p>
                  <p className="text-xs text-[var(--text-muted)] truncate">
                    {t.agent_id ?? "—"} · {t.span_count} span{t.span_count === 1 ? "" : "s"} · {t.realm}
                  </p>
                </div>
                <div className="text-right shrink-0 flex flex-col items-end gap-0.5">
                  {t.duration_ms != null && (
                    <span className="text-xs font-medium text-[var(--text-secondary)] inline-flex items-center gap-1">
                      <Clock className="w-3 h-3 text-[var(--text-muted)]" />
                      {formatDuration(t.duration_ms)}
                    </span>
                  )}
                  <span className="text-xs text-[var(--text-muted)]">{formatRelative(t.started_at)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OutcomeDot({ outcome }: { outcome: string | null }) {
  const color =
    outcome === "success"
      ? "bg-[var(--success)]"
      : outcome === "failure" || outcome === "failed"
        ? "bg-[var(--error)]"
        : outcome === "partial"
          ? "bg-[var(--warning)]"
          : "bg-[var(--text-muted)]";

  return (
    <div className={cn("w-2 h-2 rounded-full shrink-0 ring-2 ring-[var(--bg-primary)]", color)} />
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function formatRelative(iso: string): string {
  const date = new Date(iso);
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}
