"use client";

import Link from "next/link";
import type { AgentStumble } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { QueryState } from "@/components/ui/query-state";
import { Loader2 } from "lucide-react";
import { traceHref, type TracePreserveParams } from "@/lib/portal-cross-links";
import { IssueSeverityBadge } from "./issue-badges";

const COMPACT_MAX_ROWS = 5;

export function IssueStumblesList({
  stumbles,
  error,
  onRetry,
  preserve,
  compact = false,
  maxRows = COMPACT_MAX_ROWS,
  loading = false,
}: {
  stumbles: AgentStumble[];
  error?: string | null;
  onRetry?: () => void;
  preserve?: TracePreserveParams;
  /** Peek density: collapsed list, capped rows, chip-style links. */
  compact?: boolean;
  maxRows?: number;
  loading?: boolean;
}) {
  if (error) {
    return (
      <ErrorState
        size="sm"
        title="Stumbles unavailable"
        message={error}
        action={
          onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          ) : undefined
        }
      />
    );
  }

  const rows = compact ? stumbles.slice(0, maxRows) : stumbles;
  const overflow = compact && stumbles.length > rows.length ? stumbles.length - rows.length : 0;

  if (compact) {
    return (
      <QueryState
        loading={loading}
        error={null}
        data={stumbles}
        isEmpty={(d) => d.length === 0}
        loadingSlot={
          <div className="flex items-center gap-2 py-2 text-xs text-[var(--text-muted)]">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Loading evidence…
          </div>
        }
        emptySlot={
          <p className="text-xs text-[var(--text-muted)]">No stumbles recorded.</p>
        }
        errorTitle="Stumbles unavailable"
      >
        {() => (
          <ul
            className="space-y-1.5"
            data-testid="issues-detail-stumbles-peek"
            aria-label="Evidence traces"
          >
            {rows.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-2 rounded border border-[var(--border-subtle)] px-2 py-1.5"
              >
                <IssueSeverityBadge severity={s.severity} />
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-secondary)]">
                  {s.title}
                </span>
                {s.trace_id ? (
                  <Link
                    href={traceHref(
                      s.trace_id,
                      preserve,
                      s.span_id ? { spanId: String(s.span_id) } : undefined,
                    )}
                    className="shrink-0 font-mono text-2xs text-[var(--accent)] hover:underline"
                    data-testid="issue-trace-link"
                  >
                    {s.trace_id.length > 12 ? `${s.trace_id.slice(0, 8)}…` : s.trace_id}
                  </Link>
                ) : null}
              </li>
            ))}
            {overflow > 0 ? (
              <li className="text-2xs text-[var(--text-muted)]">+{overflow} more on full page</li>
            ) : null}
          </ul>
        )}
      </QueryState>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
      <h2 className="mb-3 text-sm font-semibold">Recent stumbles ({stumbles.length})</h2>
      {stumbles.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No stumbles recorded.</p>
      ) : (
        <ul className="space-y-2">
          {stumbles.map((s) => (
            <li key={s.id} className="rounded border border-[var(--border-subtle)] p-2">
              <div className="flex flex-wrap items-center gap-2">
                <IssueSeverityBadge severity={s.severity} />
                <span className="text-xs text-[var(--text-muted)]">{s.detected_by}</span>
              </div>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">{s.title}</p>
              {s.trace_id ? (
                <Link
                  href={traceHref(
                    s.trace_id,
                    preserve,
                    s.span_id ? { spanId: String(s.span_id) } : undefined,
                  )}
                  className="break-all font-mono text-xs text-[var(--accent)] hover:underline"
                  data-testid="issue-trace-link"
                >
                  {s.trace_id}
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
