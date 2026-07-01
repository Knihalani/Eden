"use client";

/**
 * SelectedTraceCard — Pattern 4.4 (Honeycomb) right-rail.
 *
 * Renders a sticky right-rail summary for a single trace. Used on
 * /observability when the user navigates here from /traces with
 * `?trace_id=<id>` (via the "View Trace Tree" action). Shows
 * trace_id, status, duration, token counts, cost, and a placeholder
 * for eval scores (the API hook is wired but currently returns null
 * — the placeholder still helps the user know the column exists).
 *
 * Curl-up feature: clicking close clears the URL param and the card
 * disappears, returning the user to the full landing view.
 */

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { X, ExternalLink, Clock, DollarSign, Hash, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import type { ObservabilityTrace } from "@/lib/api";

/** Wrapper that reads `?trace_id=` from the URL and renders the rail
 *  iff a trace is selected. Uses Suspense so Next 15 doesn't bail the
 *  whole page when search params are unavailable during prerender. */
export function SelectedTraceRail() {
  const searchParams = useSearchParams();
  const traceId = searchParams.get("trace_id") ?? searchParams.get("trace") ?? "";
  if (!traceId) return null;
  return (
    <Suspense fallback={null}>
      <SelectedTraceCard key={traceId} traceId={traceId} />
    </Suspense>
  );
}

interface SelectedTraceCardProps {
  traceId: string;
}

export function SelectedTraceCard({ traceId }: SelectedTraceCardProps) {
  const router = useRouter();
  const { currentOrg } = useOrg();
  const [trace, setTrace] = useState<ObservabilityTrace | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentOrg || !traceId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);

    // ponytail: re-use the same single-trace path that /traces uses —
    // the landing's KPI tiles are already hot on listObservabilityTraces,
    // so we just hit it again with limit=1 and trace filter. Avoids
    // a new endpoint.
    api
      .listObservabilityTraces(currentOrg.id, { limit: 50 })
      .then((res) => {
        if (cancelled) return;
        const match = (res.traces ?? []).find((t) => t.trace_id === traceId);
        setTrace(match ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setTrace(null);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentOrg, traceId]);

  return (
    <aside
      className={cn(
        "sticky top-20 w-full lg:w-72 shrink-0",
        "bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl",
        "p-4 space-y-4 self-start",
      )}
      aria-label="Selected trace"
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-medium">
            Selected trace
          </p>
          <p className="text-xs font-mono text-[var(--text-primary)] truncate mt-0.5" title={traceId}>
            {traceId.slice(0, 16)}…
          </p>
        </div>
        <button
          onClick={() => router.replace("/observability")}
          className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors shrink-0"
          aria-label="Clear selected trace"
          title="Clear selected trace"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </header>

      {loading ? (
        <div className="space-y-2 animate-pulse">
          <div className="h-4 bg-[var(--bg-tertiary)] rounded w-2/3" />
          <div className="h-4 bg-[var(--bg-tertiary)] rounded w-1/2" />
          <div className="h-4 bg-[var(--bg-tertiary)] rounded w-3/4" />
        </div>
      ) : !trace ? (
        <p className="text-xs text-[var(--text-muted)]">
          Trace <span className="font-mono">{traceId.slice(0, 8)}</span> not found in the last 50 traces.
        </p>
      ) : (
        <dl className="space-y-2.5 text-xs">
          <Row
            label="Status"
            value={
              <span
                className={cn(
                  "px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase",
                  trace.outcome === "success"
                    ? "bg-[var(--terminal-faint)] text-[var(--terminal)]"
                    : trace.outcome === "failure" || trace.outcome === "crash"
                      ? "bg-[var(--error-dim)] text-[var(--error)]"
                      : trace.outcome === "timeout"
                        ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                        : "bg-[var(--bg-tertiary)] text-[var(--text-muted)]",
                )}
              >
                {trace.outcome ?? "unknown"}
              </span>
            }
          />
          <Row icon={Clock} label="Duration" value={`${trace.duration_ms.toFixed(0)}ms`} />
          <Row icon={Hash} label="Spans" value={String(trace.span_count)} />
          <Row
            icon={Activity}
            label="Tokens"
            value={
              trace.input_tokens != null || trace.output_tokens != null
                ? `${formatTokens(trace.input_tokens)} / ${formatTokens(trace.output_tokens)}`
                : "—"
            }
          />
          <Row
            icon={DollarSign}
            label="Cost"
            value={
              trace.cost_cents != null
                ? `$${(trace.cost_cents / 100).toFixed(2)}`
                : "—"
            }
          />
          <Row label="Realm" value={trace.realm} />
          <Row label="Model" value={trace.model ?? "—"} />
          {/* Eval scores placeholder — the API doesn't surface per-trace
              scores yet. When /observability/eval/coverage ships, this
              will become a 0-100 numeric or "—" badge. */}
          <Row label="Eval score" value="—" hint="Wires to /observability/eval/coverage when shipped." />
        </dl>
      )}

      <Link
        href={`/replay?trace_id=${traceId}`}
        className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline"
      >
        Open in Replay <ExternalLink className="w-3 h-3" />
      </Link>
    </aside>
  );
}

function Row({
  label,
  value,
  icon: Icon,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="inline-flex items-center gap-1.5 text-[var(--text-muted)] shrink-0">
        {Icon && <Icon className="w-3 h-3" />}
        <span className="text-[10px] uppercase tracking-wider">{label}</span>
      </span>
      <span className="text-[var(--text-primary)] font-mono text-right" title={hint}>
        {value}
      </span>
    </div>
  );
}

function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}
