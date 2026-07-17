"use client";

/**
 * /traces — U01 Traces Hub: Traces | Spans | Sessions with split-pane detail.
 */

import { useCallback, useMemo, useState, Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Layers, RefreshCw, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { TracesTab } from "../observability/_components/TracesTab";
import { AnnotateTraceDialog } from "../observability/_components/AnnotateTraceDialog";
import type { TraceFilter, TraceItem } from "../observability/_lib/types";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { TraceExportModal } from "../observability/_components/TraceExportModal";
import { LiveTailPanel } from "./_components/LiveTailPanel";
import { SpanSearchBar } from "./_components/SpanSearchBar";
import {
  ResourcePageShell,
  QueryFilterBar,
  ViewsMenu,
  DetailPanelShell,
  BulkActionBar,
  useResourceUrlState,
  useSavedViews,
  type FilterMode,
} from "@/components/portal-os";
import { TraceDetailPanel } from "@/components/traces/TraceDetailPanel";
import { SpansTab } from "@/components/traces/SpansTab";
import { SessionsTab } from "@/components/traces/SessionsTab";
import { useQueryTab } from "@/hooks/use-query-tab";
import { parseQueryLanguage } from "@/lib/query-language";
import { usePagePerf, useTableQueryPerf, markEden } from "@/lib/perf";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";

const HUB_VIEWS = ["traces", "spans", "sessions"] as const;
const LEGACY_VIEWS = ["inspect", "replay", "debug", "query"] as const;
const ALL_VIEWS = [...HUB_VIEWS, ...LEGACY_VIEWS] as const;

const InspectView = dynamic(() => import("@/app/(portal)/inspector/page"), {
  ssr: false,
  loading: () => <ViewLoading />,
});
const ReplayView = dynamic(() => import("@/app/(portal)/replay/page"), {
  ssr: false,
  loading: () => <ViewLoading />,
});
const DebugView = dynamic(() => import("@/app/(portal)/debugger/page"), {
  ssr: false,
  loading: () => <ViewLoading />,
});
const QueryView = dynamic(() => import("@/app/(portal)/observability/query/page"), {
  ssr: false,
  loading: () => <ViewLoading />,
});

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
  const searchParams = useSearchParams();
  const { state: urlState, setState: setUrlState } = useResourceUrlState();
  const [hubView, setHubView] = useQueryTab("view", ALL_VIEWS, "traces");
  const isLegacyView = (LEGACY_VIEWS as readonly string[]).includes(hubView);

  const traceId =
    urlState.traceId ?? searchParams.get("trace_id") ?? searchParams.get("trace") ?? "";
  const savedViewId = searchParams.get("view") ?? undefined;

  const [filterMode, setFilterMode] = useState<FilterMode>("basic");
  const [filter, setFilter] = useState<TraceFilter>({ realm: "", outcome: "", agent_id: "" });
  const [query, setQuery] = useState(urlState.q ?? "");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportTraceId, setExportTraceId] = useState("");
  const [annotateOpen, setAnnotateOpen] = useState(false);
  const [annotateTraceId, setAnnotateTraceId] = useState("");

  const { views, save, remove, resolveView } = useSavedViews("traces");
  const savedState = resolveView(savedViewId);

  const effectiveFilter = useMemo(() => {
    const base = { ...filter };
    const qParsed = parseQueryLanguage(query);
    if (qParsed.agent_id) base.agent_id = qParsed.agent_id;
    if (qParsed.outcome) base.outcome = qParsed.outcome;
    if (qParsed.realm) base.realm = qParsed.realm;
    if (savedState?.filter) Object.assign(base, savedState.filter);
    return base;
  }, [filter, query, savedState]);

  const traceFilterParams = useMemo(
    () => ({
      ...(effectiveFilter.realm ? { realm: effectiveFilter.realm } : {}),
      ...(effectiveFilter.outcome ? { outcome: effectiveFilter.outcome } : {}),
      ...(effectiveFilter.agent_id ? { agent_id: effectiveFilter.agent_id } : {}),
      limit,
    }),
    [effectiveFilter, limit],
  );

  const tracesQuery = useOrgQuery(
    queryKeys.observability.traces(orgId, traceFilterParams),
    orgId,
    () => api.listObservabilityTraces(orgId!, traceFilterParams),
  );

  const traces = (tracesQuery.data?.traces ?? []) as unknown as TraceItem[];
  const tracesTotal = tracesQuery.data?.total ?? traces.length;
  const loading = tracesQuery.isLoading;
  const refreshing = tracesQuery.isFetching;
  const errorMessage = tracesQuery.error?.message ?? null;

  usePagePerf("/traces");
  useTableQueryPerf("/traces", refreshing, loading);

  useEffect(() => {
    if (traceId) markEden("eden:panel_open", "trace");
  }, [traceId]);

  const refresh = useCallback(() => {
    void tracesQuery.refetch();
  }, [tracesQuery]);

  const handleSelectTrace = useCallback(
    (id: string) => {
      setUrlState({ traceId: id });
    },
    [setUrlState],
  );

  const handleCloseDetail = useCallback(() => {
    setUrlState({ traceId: undefined });
  }, [setUrlState]);

  const handleViewTimeline = useCallback(
    (id: string) => {
      setUrlState({ traceId: id });
      setHubView("traces");
    },
    [setUrlState, setHubView],
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
      window.location.href = `/alerts?${params.toString()}`;
    },
    [],
  );

  const filterDirty =
    Boolean(query) ||
    Boolean(filter.realm || filter.outcome || filter.agent_id);

  const applyView = useCallback(
    (viewId: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (!viewId) params.delete("view");
      else params.set("view", viewId);
      const vs = resolveView(viewId);
      if (vs?.q) {
        setQuery(vs.q);
        params.set("q", vs.q);
      }
      if (vs?.filter) setFilter((f) => ({ ...f, ...vs.filter }));
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}?${params.toString()}`,
      );
    },
    [resolveView, searchParams],
  );

  if (!currentOrg) return <NoOrgState feature="Traces" />;

  const toolbar = (
    <div className="space-y-3">
      <div
        role="tablist"
        aria-label="Observe hub"
        className="flex flex-wrap gap-1 border-b border-[var(--border-default)]"
      >
        {HUB_VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={hubView === v}
            onClick={() => setHubView(v)}
            className={cn(
              "px-3 py-2 text-sm font-medium capitalize border-b-2 -mb-px",
              hubView === v
                ? "border-[var(--accent)] text-[var(--text-primary)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]",
            )}
          >
            {v}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 text-xs text-[var(--text-muted)] pb-1">
          <Link href="/traces?view=inspect" className="hover:text-[var(--accent)]">
            Inspector
          </Link>
          <Link href="/traces?view=replay" className="hover:text-[var(--accent)]">
            Replay
          </Link>
          <Link href="/traces?view=debug" className="hover:text-[var(--accent)]">
            Debugger
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-3">
        <QueryFilterBar
          mode={filterMode}
          onModeChange={setFilterMode}
          filters={{
            realm: filter.realm ?? "",
            outcome: filter.outcome ?? "",
            agent_id: filter.agent_id ?? "",
          }}
          onFiltersChange={(next) =>
            setFilter({
              realm: next.realm ?? "",
              outcome: next.outcome ?? "",
              agent_id: next.agent_id ?? "",
            })
          }
          query={query}
          onQueryChange={(q) => {
            setQuery(q);
            setUrlState({ q });
          }}
          selects={[
            {
              key: "realm",
              label: "All realms",
              value: filter.realm ?? "",
              options: [
                { value: "prod", label: "prod" },
                { value: "staging", label: "staging" },
                { value: "dev", label: "dev" },
              ],
            },
            {
              key: "outcome",
              label: "All outcomes",
              value: filter.outcome ?? "",
              options: [
                { value: "success", label: "success" },
                { value: "failure", label: "failure" },
                { value: "partial", label: "partial" },
                { value: "timeout", label: "timeout" },
              ],
            },
          ]}
          onCreateAlert={() => handleCreateAlertFromFilters(filter)}
          className="flex-1 min-w-[20rem]"
        />
        <ViewsMenu
          views={views}
          activeViewId={savedViewId}
          dirty={filterDirty}
          onSelect={applyView}
          onSave={async (name) => {
            await save({
              name,
              state: { q: query, filter: { ...filter } },
            });
          }}
          onDiscard={() => {
            setQuery("");
            setFilter({ realm: "", outcome: "", agent_id: "" });
            applyView("");
          }}
          onDelete={async (id) => remove(id)}
        />
        <Button variant="outline" size="default" onClick={refresh} loading={refreshing} aria-label="Refresh traces">
          <RefreshCw className="w-4 h-4" aria-hidden />
          Refresh
        </Button>
      </div>
    </div>
  );

  const tableContent = (
    <>
      {errorMessage && !loading && (
        <ErrorState
          title="Could not load traces"
          message={errorMessage}
          action={
            <Button onClick={refresh} variant="outline" loading={refreshing}>
              Try again
            </Button>
          }
        />
      )}
      {hubView === "traces" && (
        <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
          <div className="space-y-4 min-w-0">
            <SpanSearchBar orgId={currentOrg.id} onSelectTrace={handleSelectTrace} />
            <TracesTab
              traces={traces}
              loading={loading}
              filter={effectiveFilter}
              onFilterChange={setFilter}
              onSelectTrace={handleSelectTrace}
              onViewTimeline={handleViewTimeline}
              onExport={handleExport}
              onAnnotate={handleAnnotate}
              onCreateAlertFromFilters={handleCreateAlertFromFilters}
              initialTraceId={traceId || undefined}
              hasMore={!loading && !errorMessage && tracesTotal > traces.length}
              onLoadMore={() => setLimit((l) => l + PAGE_SIZE)}
              loadingMore={refreshing}
            />
          </div>
          <LiveTailPanel orgId={currentOrg.id} onSelectTrace={handleSelectTrace} />
        </div>
      )}
      {hubView === "spans" && orgId && (
        <SpansTab orgId={orgId} query={query} onSelectTrace={handleSelectTrace} />
      )}
      {hubView === "sessions" && orgId && (
        <SessionsTab
          orgId={orgId}
          agentId={effectiveFilter.agent_id || undefined}
          onSelectSession={(sid) => {
            window.location.href = `/sessions/${encodeURIComponent(sid)}`;
          }}
        />
      )}
    </>
  );

  return (
    <PageContent size="wide" className="space-y-6">
      <PageHeader
        eyebrow="Observe"
        title="Traces"
        subtitle="Traces, spans, and sessions — shareable filters and inline transcript detail."
        icon={Layers}
      />

      <ResourcePageShell
        toolbar={isLegacyView ? undefined : toolbar}
        table={
          isLegacyView ? (
            <EmbeddedSurface>
              {hubView === "inspect" && <InspectView />}
              {hubView === "replay" && <ReplayView />}
              {hubView === "debug" && <DebugView />}
              {hubView === "query" && <QueryView />}
            </EmbeddedSurface>
          ) : (
            tableContent
          )
        }
        detail={
          traceId ? (
            <DetailPanelShell
              open
              onClose={handleCloseDetail}
              title={
                <span className="font-mono text-xs truncate">{traceId.slice(0, 20)}…</span>
              }
            >
              <TraceDetailPanel traceId={traceId} onClose={handleCloseDetail} />
            </DetailPanelShell>
          ) : null
        }
        bulkBar={
          <BulkActionBar
            count={selectedIds.length}
            onClear={() => setSelectedIds([])}
            actions={[
              {
                label: "Export",
                onClick: () => {
                  if (selectedIds[0]) handleExport(selectedIds[0]);
                },
              },
            ]}
          />
        }
      />

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
    </PageContent>
  );
}

export default function TracesPage() {
  return (
    <Suspense fallback={<LoadingSkeleton variant="table" lines={6} size="wide" />}>
      <TracesPageInner />
    </Suspense>
  );
}
