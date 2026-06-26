"use client";

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { usePolling } from "@/hooks/use-polling";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import {
  Search,
  ChevronRight,
  ChevronDown,
  Wrench,
  Brain,
  Box,
  Eye,
  EyeOff,
  Clock,
  XCircle,
  Compass,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Trace Inspector — Phase 5.4.3
 *
 * A focused, single-trace view that complements the replay page. Whereas
 * replay shows timeline + HILT controls, the inspector is a searchable,
 * tree-structured view of one trace with:
 *   - Full event log (chronological)
 *   - Span tree (parent/child)
 *   - Tool calls, model thoughts, env steps — all expandable
 *   - Filter by type
 *   - Jump to timestamp
 *
 * Reads from the observability API: getTraceTree, getTimeline.
 */

type Span = {
  span_id: string;
  parent_span_id?: string | null;
  name: string;
  span_type: "llm_completion" | "tool_invocation" | "env_step" | "reasoning" | "user_interaction" | "system";
  duration_ms: number;
  start_offset_ms: number;
  payload: Record<string, unknown>;
};

type Filter = "all" | "llm" | "tool" | "env" | "reasoning";

const FILTER_LABELS: Record<Filter, string> = {
  all: "All",
  llm: "Model",
  tool: "Tools",
  env: "Env",
  reasoning: "Reasoning",
};

const SPAN_ICONS: Record<Span["span_type"], typeof Brain> = {
  llm_completion: Brain,
  tool_invocation: Wrench,
  env_step: Box,
  reasoning: Brain,
  user_interaction: Brain,
  system: Box,
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

interface SpanNodeProps {
  span: Span;
  depth: number;
  query: string;
}

function SpanNode({ span, depth, query }: SpanNodeProps) {
  const [open, setOpen] = useState(depth < 2);
  const matchesQuery =
    !query ||
    span.name.toLowerCase().includes(query.toLowerCase()) ||
    JSON.stringify(span.payload).toLowerCase().includes(query.toLowerCase());
  if (!matchesQuery && depth > 0) return null;

  const Icon = SPAN_ICONS[span.span_type] ?? Box;

  return (
    <div className="font-mono text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left",
          "hover:bg-[var(--bg-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]",
          depth === 0 && "bg-[var(--bg-tertiary)]"
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
        )}
        <Icon className="h-3 w-3 shrink-0 text-[var(--accent)]" />
        <span className="flex-1 truncate text-[var(--text-primary)]">{span.name}</span>
        <span className="shrink-0 text-[var(--text-muted)]">
          {formatDuration(span.duration_ms)}
        </span>
      </button>
      {open && (
        <pre className="ml-8 mr-2 mb-2 overflow-x-auto rounded border border-[var(--border-subtle)] bg-[var(--bg-base)] p-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
          {JSON.stringify(span.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function TraceInspectorPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [traceId, setTraceId] = useState<string>("");
  const [spans, setSpans] = useState<Span[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);

  const loadTrace = useCallback(
    async (id: string) => {
      if (!currentOrg || !id) return;
      setLoading(true);
      setError(null);
      try {
        const tree = await api.getTraceTree(currentOrg.id, id);
        // The API returns a tree of root_spans; flatten recursively for the
        // tree view. Unknown fields fall back to best-effort shape.
        const flat: Span[] = [];
        const visit = (node: Record<string, unknown>) => {
          const children = (node.children as Array<Record<string, unknown>>) ?? [];
          for (const child of children) {
            flat.push({
              span_id: String(child.span_id ?? ""),
              parent_span_id: (child.parent_span_id as string | null | undefined) ?? null,
              name: String(child.name ?? "unnamed"),
              span_type: (child.span_type as Span["span_type"]) ?? "system",
              duration_ms: Number(child.duration_ms ?? 0),
              start_offset_ms: Number(child.start_offset_ms ?? 0),
              payload: (child.payload as Record<string, unknown>) ?? {},
            });
            visit(child);
          }
        };
        const roots = Array.isArray(tree?.root_spans) ? tree.root_spans : [];
        for (const root of roots) visit(root);
        setSpans(flat);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to load trace";
        setError(msg);
        toast.error(msg);
      } finally {
        setLoading(false);
      }
    },
    [currentOrg, toast]
  );

  // Auto-refresh polling — cost-safe via shared hook (pauses on
  // tab-hidden, backs off on errors, bails on auth failures).
  usePolling({
    fetch: () => loadTrace(traceId),
    intervalMs: 3_000,
    enabled: Boolean(autoRefresh && traceId),
    deps: [autoRefresh, traceId, loadTrace],
  });

  // Filter spans
  const filteredSpans = spans.filter((s) => {
    if (filter === "all") return true;
    if (filter === "llm") return s.span_type === "llm_completion";
    if (filter === "tool") return s.span_type === "tool_invocation";
    if (filter === "env") return s.span_type === "env_step";
    if (filter === "reasoning") return s.span_type === "reasoning";
    return true;
  });

  // Build a flat-ordered tree using parent_span_id
  const orderedSpans: Span[] = [];
  const byParent = new Map<string | null, Span[]>();
  for (const s of filteredSpans) {
    const key = s.parent_span_id ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(s);
  }
  const walk = (parent: string | null) => {
    const children = byParent.get(parent) ?? [];
    for (const c of children) {
      orderedSpans.push(c);
      walk(c.span_id);
    }
  };
  walk(null);

  if (!currentOrg) {
    return <NoOrgState feature="Trace Inspector" />;
  }

  return (
    // Matches the canonical page wrapper used by every other portal
    // page (``p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-6
    // page-enter``). The previous ``min-h-full`` here was a leftover
    // from the old ``h-screen + overflow-clip`` (portal) contract
    // that was retired in June 2026; with the new flex layout it
    // collapsed the page. June 2026 layout-pass fix.
    <div className="page-enter p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-6 bg-[var(--bg-base)]">
      <PageHeader
        eyebrow="Observe"
        title="Trace Inspector"
        subtitle="Drill into one trace: span tree, tool calls, model thoughts, env steps."
        icon={Compass}
      />

        {/* Toolbar */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Input
            placeholder="Trace or job ID…"
            value={traceId}
            onChange={(e) => setTraceId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && loadTrace(traceId)}
            className="max-w-xs"
          />
          <Button
            onClick={() => loadTrace(traceId)}
            disabled={!traceId || loading}
          >
            Load
          </Button>
          <div className="mx-3 h-5 w-px bg-[var(--border-subtle)]" />
          {(["all", "llm", "tool", "env", "reasoning"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded px-2 py-1 text-xs font-medium transition-colors",
                filter === f
                  ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
              )}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
          <div className="mx-3 h-5 w-px bg-[var(--border-subtle)]" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAutoRefresh((v) => !v)}
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

        {/* Search */}
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--text-muted)]" />
          <Input
            placeholder="Search spans by name or content…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
          />
        </div>

        {/* Body */}
        <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] p-4">
          {!traceId ? (
            <EmptyState />
          ) : loading ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-5/6" />
              <Skeleton className="h-8 w-4/6" />
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-sm text-[var(--error)]">
              <XCircle className="h-4 w-4" />
              {error}
            </div>
          ) : orderedSpans.length === 0 ? (
            <div className="text-center text-sm text-[var(--text-muted)]">
              No spans match the current filter.
            </div>
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

        {/* Footer summary */}
        {orderedSpans.length > 0 && (
          <footer className="mt-4 flex items-center gap-4 text-xs text-[var(--text-muted)]">
            <span>{orderedSpans.length} spans</span>
            <span>
              Total: {formatDuration(
                Math.max(...orderedSpans.map((s) => s.start_offset_ms + s.duration_ms))
              )}
            </span>
            <Clock className="ml-auto h-3 w-3" />
          </footer>
        )}
    </div>
  );
}

function depthOf(span: Span, all: Span[]): number {
  let d = 0;
  let parent = span.parent_span_id;
  while (parent) {
    d += 1;
    const p = all.find((s) => s.span_id === parent);
    if (!p) break;
    parent = p.parent_span_id;
  }
  return d;
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Search className="mb-3 h-8 w-8 text-[var(--text-muted)]" />
      <p className="text-sm text-[var(--text-secondary)]">
        Enter a trace ID to inspect its span tree.
      </p>
      <p className="mt-1 text-xs text-[var(--text-muted)]">
        Tip: trace IDs are visible in the replay page URL or via the observability dashboard.
      </p>
    </div>
  );
}
