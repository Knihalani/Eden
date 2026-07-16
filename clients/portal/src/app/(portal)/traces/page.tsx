"use client";

/**
 * /traces — Trace Explorer (real page, June 2026).
 *
 * Replaces the old redirect stub `router.replace("/observability#traces")`
 * with a first-class route that:
 *   • Has its own PageHeader
 *   • Uses the extracted TracesTab component
 *   • Honors `?trace_id=abc-123` deep links (pre-selects the row)
 *   • Has its own loading.tsx (LoadingSkeleton variant="table")
 *
 * The export action is wired through the same TraceExportModal that's
 * still used by the legacy /observability page. Once that page becomes
 * a thin landing, the export modal can be promoted to a shared
 * component and reused here.
 */

import { useCallback, useMemo, useState , Suspense} from "react";
import { useSearchParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Layers, RefreshCw, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import { TracesTab } from "../observability/_components/TracesTab";
import { AnnotateTraceDialog } from "../observability/_components/AnnotateTraceDialog";
import type { TraceFilter, TraceItem } from "../observability/_lib/types";
import { useOrg } from "@/hooks/use-org";
import { api, agentSessionsApi } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { SessionTimeline, type AgentSessionTimelineItem } from "@/components/observability/SessionTimeline";
import { TraceExportModal } from "../observability/_components/TraceExportModal";
import { TraceShareModal } from "../observability/_components/TraceShareModal";
import { LiveTailPanel } from "./_components/LiveTailPanel";
import { SpanSearchBar } from "./_components/SpanSearchBar";
import { SelectedTraceRail } from "../observability/_components/SelectedTraceCard";
import { useQueryTab } from "@/hooks/use-query-tab";
import { cn } from "@/lib/utils";

const TRACE_VIEWS = ["list", "inspect", "replay", "debug", "query"] as const;
const TRACE_FACETS = ["", "mcp", "decisions", "memory", "retrieval"] as const;

const InspectView = dynamic(() => import("@/app/(portal)/inspector/page"), { ssr: false, loading: () => <ViewLoading /> });
const ReplayView = dynamic(() => import("@/app/(portal)/replay/page"), { ssr: false, loading: () => <ViewLoading /> });
const DebugView = dynamic(() => import("@/app/(portal)/debugger/page"), { ssr: false, loading: () => <ViewLoading /> });
const QueryView = dynamic(() => import("@/app/(portal)/observability/query/page"), { ssr: false, loading: () => <ViewLoading /> });

function ViewLoading() {
  return (
    <div className="flex h-48 items-center justify-center">
      <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
    </div>
  );
}

const PAGE_SIZE = 50;

function TracesPageInner() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTraceId = searchParams.get("trace_id") || undefined;
  const [view, setView] = useQueryTab("view", TRACE_VIEWS, "list");
  const facetRaw = searchParams.get("facet") || "";
  const facet = TRACE_FACETS.includes(facetRaw as (typeof TRACE_FACETS)[number])
    ? facetRaw
    : "";

  const setFacet = (next: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (!next) params.delete("facet");
    else params.set("facet", next);
    const q = params.toString();
    router.replace(q ? `/traces?${q}` : "/traces");
  };

  const [filter, setFilter] = useState<TraceFilter>({ realm: "", outcome: "", agent_id: "" });
  // "Load more" bumps the fetch limit rather than an offset — the
  // trace list endpoint has no cursor/offset param, so each bump
  // re-fetches the top N traces (same pattern the dashboard's
  // 50-row shard already uses).
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [_, setSelectedTraceId] = useState<string>(initialTraceId ?? "");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportTraceId, setExportTraceId] = useState<string>("");
  // Pattern 5.2 (Langfuse): dialog state. Lives at the page level
  // so the dialog portals cleanly to body regardless of the table
  // re-rendering.
  const [annotateOpen, setAnnotateOpen] = useState(false);
  const [annotateTraceId, setAnnotateTraceId] = useState<string>("");
  const [shareOpen, setShareOpen] = useState(false);
  const [shareTraceId, setShareTraceId] = useState<string>("");

  const traceFilterParams = useMemo(
    () => ({
      ...(filter.realm ? { realm: filter.realm } : {}),
      ...(filter.outcome ? { outcome: filter.outcome } : {}),
      ...(filter.agent_id ? { agent_id: filter.agent_id } : {}),
      limit,
    }),
    [filter, limit],
  );

  const tracesQuery = useOrgQuery(
    queryKeys.observability.traces(orgId, traceFilterParams),
    orgId,
    () => api.listObservabilityTraces(orgId!, traceFilterParams),
  );
  const sessionsQuery = useOrgQuery(
    queryKeys.agents.sessions(orgId, filter.agent_id ? { agent_id: filter.agent_id } : {}),
    orgId,
    () =>
      agentSessionsApi
        .list(orgId!, { ...(filter.agent_id ? { agent_id: filter.agent_id } : {}), limit: 50 })
        .then((res) => res.data?.sessions ?? [])
        .catch(() => []),
  );

  const traces = useMemo(
    () => (tracesQuery.data?.traces ?? []) as unknown as TraceItem[],
    [tracesQuery.data],
  );
  const tracesTotal = tracesQuery.data?.total ?? traces.length;
  const sessions = sessionsQuery.data ?? [];
  const loading = tracesQuery.isLoading || sessionsQuery.isLoading;
  const refreshing = tracesQuery.isFetching || sessionsQuery.isFetching;
  const errorMessage = tracesQuery.error?.message ?? null;

  const refresh = useCallback(() => {
    void tracesQuery.refetch();
    void sessionsQuery.refetch();
  }, [tracesQuery, sessionsQuery]);

  const handleSelectTrace = useCallback(
    (id: string) => {
      setSelectedTraceId(id);
      router.push(`/traces?trace_id=${encodeURIComponent(id)}`);
    },
    [router],
  );

  const handleViewTimeline = useCallback(
    (id: string) => {
      setSelectedTraceId(id);
      router.push(`/replay?trace=${encodeURIComponent(id)}`);
    },
    [router],
  );

  const handleExport = useCallback((id: string) => {
    setExportTraceId(id);
    setExportOpen(true);
  }, []);

  const handleAnnotate = useCallback((id: string) => {
    setAnnotateTraceId(id);
    setAnnotateOpen(true);
  }, []);

  const handleCreateAlertFromFilters = useCallback(
    (f: TraceFilter) => {
      const params = new URLSearchParams({ tab: "rules" });
      if (f.realm) params.set("realm", f.realm);
      if (f.outcome) params.set("outcome", f.outcome);
      if (f.agent_id) params.set("agent_id", f.agent_id);
      router.push(`/alerts?${params.toString()}`);
    },
    [router],
  );

  const handleLoadMore = useCallback(() => {
    setLimit((l) => l + PAGE_SIZE);
  }, []);

  const sessionTimeline = useMemo(() => {
    const byId = new Map<string, AgentSessionTimelineItem>();
    for (const s of sessions) {
      byId.set(s.id, { ...s, trace_ids: [...(s.trace_ids ?? [])] });
    }
    for (const t of traces) {
      const sid = t.agent_session_id ?? t.session_id;
      if (!sid) continue;
      const existing = byId.get(sid);
      if (existing) {
        const ids = new Set(existing.trace_ids ?? []);
        ids.add(t.trace_id);
        existing.trace_ids = Array.from(ids);
        if (!existing.agent_id && t.agent_id) existing.agent_id = t.agent_id;
        if (!existing.started_at && t.started_at) existing.started_at = t.started_at;
      } else {
        byId.set(sid, {
          id: sid,
          agent_id: t.agent_id ?? null,
          trace_ids: [t.trace_id],
          started_at: t.started_at ?? undefined,
        });
      }
    }
    return Array.from(byId.values()).sort((a, b) => {
      const ta = a.started_at ? Date.parse(a.started_at) : 0;
      const tb = b.started_at ? Date.parse(b.started_at) : 0;
      return tb - ta;
    });
  }, [sessions, traces]);

  if (!currentOrg) return <NoOrgState feature="Traces" />;

  return (
    <PageContent size="wide" className="space-y-6">
      <PageHeader
        eyebrow="Observe"
        title="Traces"
        subtitle="Search, inspect, replay, and debug every agent run."
        icon={Layers}
        description="List view for exploration; switch views for inspector, replay, debugger, or query."
        actions={
          view === "list" ? (
          <Button variant="outline" size="default" onClick={refresh} loading={refreshing} aria-label="Refresh traces">
            <RefreshCw className="w-4 h-4" />
            Refresh
          </Button>
          ) : undefined
        }
      />

      <div role="tablist" aria-label="Trace views" className="flex flex-wrap gap-1 border-b border-[var(--border-default)]">
        {TRACE_VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={cn(
              "px-3 py-2 text-sm font-medium capitalize border-b-2 -mb-px",
              view === v
                ? "border-[var(--accent)] text-[var(--text-primary)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]",
            )}
          >
            {v === "list" ? "Explorer" : v}
          </button>
        ))}
      </div>

      {view === "inspect" && (
        <EmbeddedSurface>
          <InspectView />
        </EmbeddedSurface>
      )}
      {view === "replay" && (
        <EmbeddedSurface>
          <ReplayView />
        </EmbeddedSurface>
      )}
      {view === "debug" && (
        <EmbeddedSurface>
          <DebugView />
        </EmbeddedSurface>
      )}
      {view === "query" && (
        <EmbeddedSurface>
          <QueryView />
        </EmbeddedSurface>
      )}
      {view === "list" && (
      <>
      <div className="flex flex-wrap gap-1">
        {(["mcp", "decisions", "memory", "retrieval"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFacet(facet === f ? "" : f)}
            className={cn(
              "rounded-md px-2 py-1 text-[11px] font-medium",
              facet === f
                ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                : "bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]",
            )}
          >
            {f}
          </button>
        ))}
      </div>
      {errorMessage && !loading && (
        <ErrorState
          title="Could not load traces"
          message={errorMessage}
          action={
            <Button onClick={refresh} variant="outline" size="default" disabled={refreshing} loading={refreshing}>
              <RefreshCw className="w-4 h-4" />
              Try again
            </Button>
          }
        />
      )}
      <div className="flex flex-col lg:flex-row gap-6">
        <div className="grid gap-4 lg:grid-cols-[1fr_18rem] flex-1 min-w-0">
        <div className="space-y-4 min-w-0">
          <section aria-label="Agent sessions">
            <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
              Agent sessions
            </h2>
            <SessionTimeline
              sessions={sessionTimeline}
              orgId={currentOrg.id}
              className="mb-2"
            />
          </section>
          <SpanSearchBar orgId={currentOrg.id} onSelectTrace={handleSelectTrace} />
          <TracesTab
              traces={traces}
              loading={loading}
              filter={filter}
              onFilterChange={setFilter}
              onSelectTrace={handleSelectTrace}
              onViewTimeline={handleViewTimeline}
              onExport={handleExport}
              onAnnotate={handleAnnotate}
              onCreateAlertFromFilters={handleCreateAlertFromFilters}
              initialTraceId={initialTraceId}
            />
          {!loading && !errorMessage && tracesTotal > traces.length && (
            <div className="flex justify-center pt-2">
              <Button variant="outline" size="default" onClick={handleLoadMore} loading={refreshing} disabled={refreshing}>
                Load more traces
              </Button>
            </div>
          )}
        </div>
        <LiveTailPanel orgId={currentOrg.id} onSelectTrace={handleSelectTrace} />
        </div>
        <SelectedTraceRail />
      </div>
      </>
      )}
      <TraceExportModal
        open={exportOpen}
        onOpenChange={setExportOpen}
        orgId={currentOrg.id}
        traceId={exportTraceId}
      />
      <AnnotateTraceDialog
        open={annotateOpen}
        onOpenChange={setAnnotateOpen}
        traceId={annotateTraceId}
      />
      <TraceShareModal
        open={shareOpen}
        onOpenChange={setShareOpen}
        traceId={shareTraceId}
      />
    </PageContent>
  );
}


// Wrap TracesPageInner in a Suspense boundary because it reads
// ``useSearchParams()``. Without the boundary Next.js cannot
// statically optimise the page and the RSC prefetch
// (``?._rsc=...``) returns a partial / erroring payload, which
// surfaces in the browser console as a 404.
export default function TracesPage() {
  return (
    <Suspense fallback={null}>
      <TracesPageInner />
    </Suspense>
  );
}
