"use client";

import Link from "next/link";
import {
  Key,
  ArrowRight,
  Clock,
  AlertTriangle,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";
import { EmptyState } from "@/components/ui/empty-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import type { TraceRow } from "./dashboard-helpers";
import { isFailureOutcome } from "./dashboard-helpers";

/**
 * Recent failures master-list — not a full Traces OS (Wave 6 / 7).
 * Row click → `/traces` deep link with traceId.
 */
interface RecentFailuresCardProps {
  loading: boolean;
  traces: TraceRow[];
  unavailable?: boolean;
  errorMessage?: string | null;
}

const hitBtn = (variant: "default" | "outline" = "default") =>
  cn(buttonVariants({ variant, size: "default" }), "min-h-[44px] h-11");

export function RecentFailuresCard({
  loading,
  traces,
  unavailable = false,
  errorMessage = null,
}: RecentFailuresCardProps) {
  const failures = traces
    .filter((t) => isFailureOutcome(t.outcome))
    .slice(0, 8);
  const empty = !loading && !unavailable && failures.length === 0;

  return (
    <Panel
      tone="flat"
      padding="none"
      data-testid="dashboard-recent-failures"
      data-home-shell-failures="master-list"
      role="region"
      aria-labelledby="home-failures-title"
    >
      <div className="flex items-center justify-between gap-space-3 px-space-4 sm:px-space-5 pt-space-4 pb-space-3 border-b border-[var(--border-subtle)]">
        <div className="min-w-0">
          <h2
            id="home-failures-title"
            className="text-sm font-semibold text-[var(--text-primary)] m-0"
          >
            Recent failures
          </h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5 m-0">
            Failed runs in this window
          </p>
        </div>
        <Button asChild variant="ghost" size="sm" className="shrink-0">
          <Link href="/traces?outcome=failure">
            View all
            <ArrowRight className="w-3.5 h-3.5" aria-hidden />
          </Link>
        </Button>
      </div>

      {loading ? (
        <div
          className="space-y-0 px-0"
          aria-busy="true"
          aria-live="polite"
        >
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-space-3 px-space-4 sm:px-space-5 py-space-2.5 border-b border-[var(--border-subtle)] last:border-b-0"
            >
              <Skeleton className="h-1.5 w-1.5 rounded-full shrink-0" />
              <div className="flex-1 space-y-1.5 min-w-0">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
              <Skeleton className="h-3 w-12 shrink-0" />
            </div>
          ))}
        </div>
      ) : unavailable ? (
        <div
          className="px-space-4 sm:px-space-5 py-space-5"
          data-query-state="error"
          data-home-shell-state="error"
        >
          <EmptyState
            icon={AlertTriangle}
            title="Failures unavailable"
            description={
              errorMessage?.trim() ||
              "Could not load recent traces. Retry — this is not an empty inbox."
            }
            size="sm"
            variant="plain"
          />
        </div>
      ) : empty ? (
        <div
          className="px-space-4 sm:px-space-5 py-space-5"
          data-query-state="empty"
          data-empty-kind={
            traces.length === 0 ? "zero-data" : "period-empty"
          }
          data-home-shell-state="empty"
        >
          <EmptyState
            icon={AlertCircle}
            title="No failures in this window"
            description={
              traces.length === 0
                ? U20_EMPTY_COPY.dashboardTraces
                : "No failed outcomes in the selected range. Open Traces to inspect all runs."
            }
            variant="plain"
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                {traces.length === 0 ? (
                  <>
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
                  </>
                ) : (
                  <Link href="/traces" className={hitBtn("outline")}>
                    Open Traces
                  </Link>
                )}
              </div>
            }
            size="sm"
          />
        </div>
      ) : (
        <ul className="m-0 p-0 list-none divide-y divide-[var(--border-subtle)]">
          {failures.map((t) => (
            <li key={t.trace_id}>
              <Link
                href={`/traces?traceId=${encodeURIComponent(t.trace_id)}&view=traces`}
                className={cn(
                  "flex items-center gap-space-3 px-space-4 sm:px-space-5 py-space-2.5 min-h-[44px]",
                  "hover:bg-[var(--bg-tertiary)]/50 transition-colors duration-150",
                  "focus-visible:outline-none focus-visible:bg-[var(--bg-tertiary)]/50",
                )}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--error)]"
                  aria-hidden
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono text-[var(--text-primary)] truncate m-0">
                    {t.trace_id.slice(0, 16)}
                  </p>
                  <p className="text-xs text-[var(--text-muted)] truncate m-0">
                    {t.agent_id ?? "—"} · {t.span_count} span
                    {t.span_count === 1 ? "" : "s"} · {t.realm}
                  </p>
                </div>
                <div className="text-right shrink-0 flex flex-col items-end gap-0.5">
                  {t.duration_ms != null && (
                    <span className="text-xs font-mono text-[var(--text-secondary)] inline-flex items-center gap-1">
                      <Clock className="w-3 h-3 text-[var(--text-muted)]" aria-hidden />
                      {formatDuration(t.duration_ms)}
                    </span>
                  )}
                  <span className="text-xs text-[var(--text-faint)]">
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
