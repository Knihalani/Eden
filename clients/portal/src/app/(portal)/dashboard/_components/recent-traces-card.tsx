"use client";

import Link from "next/link";
import { Key, ArrowRight, Clock, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";

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
  /** Soft-fail / outage — do not present as first-run empty. */
  unavailable?: boolean;
  errorMessage?: string | null;
}

const hitBtn = (variant: "default" | "outline" = "default") =>
  cn(buttonVariants({ variant, size: "default" }), "min-h-[44px] h-11");

export function RecentTracesCard({
  loading,
  traces,
  unavailable = false,
  errorMessage = null,
}: RecentTracesCardProps) {
  const top = traces.slice(0, 10);
  const empty = !loading && !unavailable && top.length === 0;

  return (
    <Panel tone="flat" padding="none">
      <div className="flex items-center justify-between px-5 pt-5 pb-3">
        <div>
          <h2 className="text-base font-semibold text-[var(--text-primary)]">
            Recent Traces
          </h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            last 10 — click to inspect
          </p>
        </div>
        <Link
          href="/traces"
          className="text-xs font-medium text-[var(--accent)] hover:text-[var(--accent-hover)] inline-flex items-center gap-1 min-h-[44px] px-2"
        >
          View all
          <ArrowRight className="w-3 h-3" />
        </Link>
      </div>

      {loading ? (
        <div className="space-y-2 px-5 pb-5" aria-busy="true" aria-live="polite">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 py-1.5">
              <Skeleton className="h-2 w-2 rounded-full shrink-0" />
              <div className="flex-1 space-y-1.5 min-w-0">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
              <Skeleton className="h-3 w-12 shrink-0" />
            </div>
          ))}
        </div>
      ) : unavailable ? (
        <div className="px-5 pb-5">
          <EmptyState
            icon={AlertTriangle}
            title="Traces unavailable"
            description={
              errorMessage?.trim() ||
              "Could not load recent traces. Retry in a moment — this is not an empty inbox."
            }
            size="sm"
            variant="plain"
          />
        </div>
      ) : empty ? (
        <div className="px-5 pb-5">
          <EmptyState
            icon={Key}
            title="No traces yet"
            description={U20_EMPTY_COPY.dashboardTraces}
            variant="plain"
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Link href="/settings?tab=api-keys" className={hitBtn()}>
                  <Key className="w-4 h-4" />
                  Create API key
                </Link>
                <a
                  href={DOCS_QUICKSTART_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={hitBtn("outline")}
                >
                  Docs quickstart
                </a>
                <Link href="/traces" className={hitBtn("outline")}>
                  Open Traces
                </Link>
              </div>
            }
            size="sm"
          />
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border-subtle)]">
          {top.map((t) => (
            <li key={t.trace_id}>
              <Link
                href={`/traces?traceId=${encodeURIComponent(t.trace_id)}&view=traces`}
                className="flex items-center gap-3 px-5 py-2.5 min-h-[44px] hover:bg-[var(--bg-tertiary)]/40 transition-colors group"
              >
                <OutcomeDot outcome={t.outcome} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono text-[var(--text-primary)] truncate">
                    {t.trace_id.slice(0, 16)}
                  </p>
                  <p className="text-xs text-[var(--text-muted)] truncate">
                    {t.agent_id ?? "—"} · {t.span_count} span
                    {t.span_count === 1 ? "" : "s"} · {t.realm}
                  </p>
                </div>
                <div className="text-right shrink-0 flex flex-col items-end gap-0.5">
                  {t.duration_ms != null && (
                    <span className="text-xs font-medium text-[var(--text-secondary)] inline-flex items-center gap-1">
                      <Clock className="w-3 h-3 text-[var(--text-muted)]" />
                      {formatDuration(t.duration_ms)}
                    </span>
                  )}
                  <span className="text-xs text-[var(--text-muted)]">
                    {formatRelative(t.started_at)}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
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
    <div
      className={cn(
        "w-2 h-2 rounded-full shrink-0 ring-2 ring-[var(--bg-secondary)]",
        color,
      )}
    />
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
