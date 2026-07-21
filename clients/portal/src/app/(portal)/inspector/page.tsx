"use client";

import { useState, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { usePolling } from "@/hooks/use-polling";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageContent } from "@/components/layout/page-content";
import {
  ObserveBackToTraces,
  ObserveLeafHeader,
  WAVE10_POWER_ATTR,
  WAVE_V3_8_POWER_ATTR,
} from "@/app/(portal)/observability/_components/observe-leaf-shell";
import {
  Search,
  Eye,
  EyeOff,
  Clock,
  Compass,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { errorFromCaught } from "@/lib/safe-error-message";
import {
  TranscriptView as MessageTranscript,
} from "@/components/observability/transcript-view";
import {
  FILTER_LABELS,
  depthOf,
  filterSpans,
  flattenTraceTree,
  formatDuration,
  orderSpansByParent,
  spansToTranscriptMessages,
  type Filter,
  type Span,
  type ViewMode,
} from "./_components/inspector-helpers";
import { SpanNode } from "./_components/span-node";

export default function TraceInspectorPage() {
  const { currentOrg } = useOrg();
  const [traceId, setTraceId] = useState<string>("");
  const [spans, setSpans] = useState<Span[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("tree");
  const [query, setQuery] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);

  const loadTrace = useCallback(
    async (id: string) => {
      if (!currentOrg || !id) return;
      setLoading(true);
      setError(null);
      try {
        const tree = await api.getTraceTree(currentOrg.id, id);
        setSpans(flattenTraceTree(tree));
      } catch (err) {
        setSpans([]);
        setError(errorFromCaught(err, "Failed to load trace"));
      } finally {
        setLoading(false);
      }
    },
    [currentOrg],
  );

  usePolling({
    fetch: () => loadTrace(traceId),
    intervalMs: 15_000,
    enabled: Boolean(autoRefresh && traceId),
    deps: [autoRefresh, traceId, loadTrace],
  });

  const orderedSpans = orderSpansByParent(filterSpans(spans, filter));

  if (!currentOrg) {
    return <NoOrgState feature="Trace Inspector" />;
  }

  return (
    <PageContent className="bg-[var(--bg-base)]">
      <div
        {...WAVE10_POWER_ATTR}
        {...WAVE_V3_8_POWER_ATTR}
        className="contents"
      >
        <ObserveBackToTraces />
        <ObserveLeafHeader
          title="Inspector"
          subtitle="Span tree for one trace — open from Traces More"
          icon={Compass}
        />
      </div>

      <div
        className="mb-4 flex flex-wrap items-center gap-2"
        data-testid="inspector-slim-toolbar"
      >
        <Input
          placeholder="Trace or job ID…"
          aria-label="Trace or job ID"
          value={traceId}
          onChange={(e) => setTraceId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && loadTrace(traceId)}
          className="max-w-xs"
        />
        <Button onClick={() => loadTrace(traceId)} disabled={!traceId || loading}>
          Load
        </Button>
        <div className="mx-3 h-5 w-px bg-[var(--border-subtle)]" aria-hidden />
        <div
          role="group"
          aria-label="Filter spans by type"
          className="flex items-center gap-1"
        >
          {(["all", "llm", "tool", "env", "reasoning"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className={cn(
                "rounded px-2 py-1 text-xs font-medium transition-colors",
                filter === f
                  ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]",
              )}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
        <div className="mx-3 h-5 w-px bg-[var(--border-subtle)]" aria-hidden />
        <div role="group" aria-label="View mode" className="flex items-center gap-1">
          {(
            [
              ["tree", "Tree"],
              ["transcript", "Transcript"],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => setViewMode(mode)}
              aria-pressed={viewMode === mode}
              className={cn(
                "rounded px-2 py-1 text-xs font-medium transition-colors",
                viewMode === mode
                  ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mx-3 h-5 w-px bg-[var(--border-subtle)]" aria-hidden />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setAutoRefresh((v) => !v)}
          aria-pressed={autoRefresh}
          className="gap-1"
        >
          {autoRefresh ? (
            <Eye className="h-3 w-3" />
          ) : (
            <EyeOff className="h-3 w-3" />
          )}
          {autoRefresh ? "Auto-refresh on" : "Auto-refresh off"}
        </Button>
      </div>

      <div className="relative mb-4">
        <Search
          className="absolute left-3 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--text-muted)]"
          aria-hidden
        />
        <Input
          placeholder="Search spans by name or content…"
          aria-label="Search spans"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-8"
        />
      </div>

      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] p-4">
        {!traceId ? (
          <EmptyState
            icon={Search}
            title="Enter a trace ID"
            description="Trace IDs are visible in the replay page URL or via the observability dashboard."
            size="sm"
          />
        ) : loading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-5/6" />
            <Skeleton className="h-8 w-4/6" />
          </div>
        ) : error ? (
          <ErrorState
            title="Couldn't load trace"
            message={error}
            size="sm"
            action={
              <Button size="sm" variant="outline" onClick={() => loadTrace(traceId)}>
                Try again
              </Button>
            }
          />
        ) : orderedSpans.length === 0 ? (
          <EmptyState
            icon={Search}
            title="No matching spans"
            description="No spans match the current filter. Try widening the filter or clearing the search."
            size="sm"
          />
        ) : viewMode === "transcript" ? (
          <MessageTranscript
            messages={spansToTranscriptMessages(orderedSpans)}
          />
        ) : (
          <div className="space-y-0.5">
            {orderedSpans.map((span) => (
              <SpanNode
                key={span.span_id}
                span={span}
                depth={depthOf(span, spans)}
                query={query}
              />
            ))}
          </div>
        )}
      </div>

      {orderedSpans.length > 0 && (
        <footer className="mt-4 flex items-center gap-4 text-xs text-[var(--text-muted)]">
          <span>{orderedSpans.length} spans</span>
          <span>
            Total:{" "}
            {formatDuration(
              Math.max(
                ...orderedSpans.map((s) => s.start_offset_ms + s.duration_ms),
              ),
            )}
          </span>
          <Clock className="ml-auto h-3 w-3" />
        </footer>
      )}
    </PageContent>
  );
}
