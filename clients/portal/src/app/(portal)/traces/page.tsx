"use client";

/**
 * /traces — U01 Traces Hub: Traces | Spans | Sessions with split-pane detail.
 */

import { useCallback, useMemo, useState, Suspense, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { BookOpen, Key, Layers, RefreshCw, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { NoOrgState } from "@/components/ui/no-org-state";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { WaitingForFirstEvent } from "@/components/onboarding/WaitingForFirstEvent";
import { TracesTab } from "../observability/_components/TracesTab";
import { AnnotateTraceDialog } from "../observability/_components/AnnotateTraceDialog";
import type { TraceFilter, TraceItem } from "../observability/_lib/types";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { api, onboardingV2Api } from "@/lib/api";
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
  useResourceUrlState,
  useSavedViews,
  type FilterMode,
} from "@/components/portal-os";
import { useQueryTab } from "@/hooks/use-query-tab";
import { parseQueryLanguage } from "@/lib/query-language";
import { usePagePerf, useTableQueryPerf, markEden } from "@/lib/perf";
import { cn } from "@/lib/utils";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { FIRST_EVENT_WAIT } from "@/lib/portal-polish";
import {
  deriveTracesListUi,
  filtersFromSearchParams,
} from "./traces-list-ui";

const HUB_VIEWS = ["traces", "spans", "sessions"] as const;
const LEGACY_VIEWS = ["inspect", "replay", "debug", "query"] as const;
const FACET_VIEWS = ["mcp", "decisions", "memory", "retrieval"] as const;
const ALL_VIEWS = [...HUB_VIEWS, ...LEGACY_VIEWS] as const;

function ViewLoading() {
  return (
    <div className="flex h-48 items-center justify-center">
      <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
    </div>
  );
}

/** Hub tabs / detail — code-split like legacy views (Wave-2 hydration win). */
const SpansTab = dynamic(
  () =>
    import("@/components/traces/SpansTab").then((m) => ({ default: m.SpansTab })),
  { ssr: false, loading: () => <ViewLoading /> },
);
const SessionsTab = dynamic(
  () =>
    import("@/components/traces/SessionsTab").then((m) => ({
      default: m.SessionsTab,
    })),
  { ssr: false, loading: () => <ViewLoading /> },
);
const TraceDetailPanel = dynamic(
  () =>
    import("@/components/traces/TraceDetailPanel").then((m) => ({
      default: m.TraceDetailPanel,
    })),
  { ssr: false, loading: () => <ViewLoading /> },
);

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
const McpFacetView = dynamic(() => import("@/app/(portal)/observability/mcp/page"), {
  ssr: false,
  loading: () => <ViewLoading />,
});
const DecisionsFacetView = dynamic(
  () => import("@/app/(portal)/observability/decisions/page"),
  { ssr: false, loading: () => <ViewLoading /> },
);
const MemoryFacetView = dynamic(
  () => import("@/app/(portal)/observability/memory/page"),
  { ssr: false, loading: () => <ViewLoading /> },
);
const RetrievalFacetView = dynamic(
  () => import("@/app/(portal)/observability/retrieval/page"),
  { ssr: false, loading: () => <ViewLoading /> },
);
const PAGE_SIZE = 50;

function TracesPageInner() {
  const {
    currentOrg,
    authError,
    orgSyncing,
    orgSyncTimedOut,
    refreshOrgs,
    loading: orgLoading,
  } = useOrg();
  const { hasPermission } = usePermissions();
  // API key create/revoke is owner/admin only (settings:edit). Members
  // and viewers must not get a primary "API keys" first-run CTA.
  const canManageKeys = hasPermission("settings:edit");
  const orgId = currentOrg?.id ?? null;
  const router = useRouter();
  const searchParams = useSearchParams();
  const { state: urlState, setState: setUrlState } = useResourceUrlState();
  const [hubView, setHubView] = useQueryTab("view", ALL_VIEWS, "traces");
  const isLegacyView = (LEGACY_VIEWS as readonly string[]).includes(hubView);
  const facetParam = searchParams.get("facet");
  const activeFacet =
    facetParam && (FACET_VIEWS as readonly string[]).includes(facetParam)
      ? (facetParam as (typeof FACET_VIEWS)[number])
      : null;
  const isFacetView = activeFacet != null;

  const traceId =
    urlState.traceId ?? searchParams.get("trace_id") ?? searchParams.get("trace") ?? "";
  const spanId = urlState.spanId ?? searchParams.get("span_id") ?? undefined;
  // Hub tabs use `view=`; saved views use `savedView=` (avoids UUID clash).
  const savedViewId = searchParams.get("savedView") ?? undefined;

  const filterUrlKey = [
    searchParams.get("realm") ?? "",
    searchParams.get("outcome") ?? "",
    searchParams.get("agent_id") ?? "",
  ].join("|");

  const [filterMode, setFilterMode] = useState<FilterMode>("basic");
  const [filter, setFilter] = useState<TraceFilter>(() =>
    filtersFromSearchParams(searchParams),
  );
  const [query, setQuery] = useState(urlState.q ?? searchParams.get("q") ?? "");
  const [offset, setOffset] = useState(0);
  const [accumulated, setAccumulated] = useState<TraceItem[]>([]);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportTraceId, setExportTraceId] = useState("");
  const [annotateOpen, setAnnotateOpen] = useState(false);
  const [annotateTraceId, setAnnotateTraceId] = useState("");

  // Re-hydrate when shareable filter params change (deep link / back nav).
  useEffect(() => {
    setFilter(filtersFromSearchParams(searchParams));
  }, [filterUrlKey, searchParams]);

  const { views, save, remove, resolveView } = useSavedViews("traces");
  const savedState = resolveView(savedViewId);

  const writeFilterParams = useCallback(
    (next: TraceFilter, nextQ?: string) => {
      const params = new URLSearchParams(searchParams.toString());
      const apply = (key: string, value: string | undefined) => {
        if (!value) params.delete(key);
        else params.set(key, value);
      };
      apply("realm", next.realm || undefined);
      apply("outcome", next.outcome || undefined);
      apply("agent_id", next.agent_id || undefined);
      if (nextQ !== undefined) apply("q", nextQ || undefined);
      const qs = params.toString();
      router.replace(`${window.location.pathname}${qs ? `?${qs}` : ""}`, {
        scroll: false,
      });
    },
    [router, searchParams],
  );

  const applyListFilters = useCallback(
    (next: TraceFilter) => {
      setFilter(next);
      writeFilterParams(next);
    },
    [writeFilterParams],
  );

  const effectiveFilter = useMemo(() => {
    const base = { ...filter };
    const qParsed = parseQueryLanguage(query);
    if (qParsed.agent_id) base.agent_id = qParsed.agent_id;
    if (qParsed.outcome) base.outcome = qParsed.outcome;
    if (qParsed.realm) base.realm = qParsed.realm;
    if (savedState?.filter) Object.assign(base, savedState.filter);
    return base;
  }, [filter, query, savedState]);

  const filterKey = useMemo(
    () =>
      JSON.stringify({
        realm: effectiveFilter.realm ?? "",
        outcome: effectiveFilter.outcome ?? "",
        agent_id: effectiveFilter.agent_id ?? "",
        q: query,
        savedViewId: savedViewId ?? "",
      }),
    [
      effectiveFilter.realm,
      effectiveFilter.outcome,
      effectiveFilter.agent_id,
      query,
      savedViewId,
    ],
  );

  // Reset offset pagination synchronously when filters change so the
  // next fetch never uses a stale offset from a prior Load more.
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  let pageOffset = offset;
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setOffset(0);
    setAccumulated([]);
    pageOffset = 0;
  }

  const traceFilterParams = useMemo(
    () => ({
      ...(effectiveFilter.realm ? { realm: effectiveFilter.realm } : {}),
      ...(effectiveFilter.outcome ? { outcome: effectiveFilter.outcome } : {}),
      ...(effectiveFilter.agent_id ? { agent_id: effectiveFilter.agent_id } : {}),
      // K8: include days so dashboard/traces share the same queryKeys factory shape.
      days: 7,
      limit: PAGE_SIZE,
      offset: pageOffset,
    }),
    [effectiveFilter, pageOffset],
  );

  const filterDirty =
    Boolean(query) ||
    Boolean(filter.realm || filter.outcome || filter.agent_id) ||
    Boolean(savedViewId);

  const tracesQuery = useOrgQuery(
    queryKeys.observability.traces(orgId, traceFilterParams),
    orgId,
    () => api.listObservabilityTraces(orgId!, traceFilterParams),
    {
      // Soft poll while first-run empty so doctor / SDK traffic appears
      // without a hard refresh. Stops once rows exist or filters are on.
      refetchInterval: (q) => {
        if (filterDirty || q.state.error) return false;
        const data = q.state.data;
        if (!data) return false;
        const total = data.total ?? data.traces?.length ?? 0;
        return total === 0 ? FIRST_EVENT_WAIT.pollMs : false;
      },
    },
  );

  // Merge pages client-side — BE returns one page per (limit, offset).
  useEffect(() => {
    if (!tracesQuery.data) return;
    const page = (tracesQuery.data.traces ?? []) as unknown as TraceItem[];
    setAccumulated((prev) => {
      if (pageOffset === 0) return page;
      const seen = new Set(prev.map((t) => t.trace_id));
      return [...prev, ...page.filter((t) => !seen.has(t.trace_id))];
    });
  }, [tracesQuery.data, pageOffset]);

  const traces = accumulated;
  const tracesTotal = tracesQuery.data?.total ?? traces.length;
  const refreshing = tracesQuery.isFetching;
  const loadingMore = tracesQuery.isFetching && pageOffset > 0;
  const errorMessage = tracesQuery.error?.message ?? null;

  const listUi = deriveTracesListUi({
    isLoading: tracesQuery.isLoading,
    isFetched: tracesQuery.isFetched,
    isError: tracesQuery.isError,
    accumulatedCount: accumulated.length,
    filterDirty,
  });
  const { loading, showError, showFirstRunEmpty, showFilteredEmpty } = listUi;

  // Soft-wire onboarding v2 ``first_trace_at`` when waiting — ignore failures.
  const firstTraceSignal = useOrgQuery(
    ["onboarding-v2-first-trace", orgId],
    orgId,
    async () => {
      try {
        const res = await onboardingV2Api.getState(orgId!);
        return res.data.first_trace_at ?? null;
      } catch {
        return null;
      }
    },
    {
      enabled: showFirstRunEmpty,
      staleTime: FIRST_EVENT_WAIT.pollMs,
      refetchInterval: showFirstRunEmpty ? FIRST_EVENT_WAIT.pollMs : false,
    },
  );
  const firstTraceAt = firstTraceSignal.data ?? null;

  usePagePerf("/traces");
  useTableQueryPerf("/traces", refreshing, loading);

  useEffect(() => {
    if (traceId) markEden("eden:panel_open", "trace");
  }, [traceId]);

  const refresh = useCallback(() => {
    void tracesQuery.refetch();
    void firstTraceSignal.refetch();
  }, [tracesQuery, firstTraceSignal]);

  const handleSelectTrace = useCallback(
    (id: string, nextSpanId?: string) => {
      setUrlState({
        traceId: id,
        spanId: nextSpanId || undefined,
      });
    },
    [setUrlState],
  );

  const handleCloseDetail = useCallback(() => {
    setUrlState({ traceId: undefined, spanId: undefined });
  }, [setUrlState]);

  const handleViewTimeline = useCallback(
    (id: string) => {
      setUrlState({ traceId: id, spanId: undefined });
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
      router.push(`/alerts?${params.toString()}`);
    },
    [router],
  );

  const applyView = useCallback(
    (viewId: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (!viewId) params.delete("savedView");
      else params.set("savedView", viewId);
      const vs = resolveView(viewId);
      if (vs?.q) {
        setQuery(vs.q);
        params.set("q", vs.q);
      }
      if (vs?.filter) {
        const next = {
          realm: "",
          outcome: "",
          agent_id: "",
          ...vs.filter,
        };
        setFilter(next);
        if (next.realm) params.set("realm", next.realm);
        else params.delete("realm");
        if (next.outcome) params.set("outcome", next.outcome);
        else params.delete("outcome");
        if (next.agent_id) params.set("agent_id", next.agent_id);
        else params.delete("agent_id");
      }
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}?${params.toString()}`,
      );
    },
    [resolveView, searchParams],
  );

  // Avoid false "No traces yet" / empty hub while org context is still
  // loading — orgless users are redirected to /settings?tab=org by chrome.
  if (orgLoading && !currentOrg && !authError) {
    return (
      <div className="p-6" aria-busy="true" aria-label="Loading workspace">
        <LoadingSkeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!currentOrg && !authError) {
    return (
      <NoOrgState
        feature="Traces"
        syncing={orgSyncing && !orgSyncTimedOut}
        syncTimedOut={orgSyncTimedOut}
        onRetrySync={() => void refreshOrgs()}
        description={
          orgSyncTimedOut
            ? undefined
            : orgSyncing
              ? undefined
              : "Create an organization to view traces. The product tour does not create or sync your workspace."
        }
      />
    );
  }
  if (!currentOrg) return null;

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
              "min-h-11 px-3 py-2 text-sm font-medium capitalize border-b-2 -mb-px",
              hubView === v
                ? "border-[var(--accent)] text-[var(--text-primary)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]",
            )}
          >
            {v}
          </button>
        ))}
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)] pb-1">
          <Link href="/traces?view=inspect" className="hover:text-[var(--accent)]">
            Inspector
          </Link>
          <Link href="/traces?view=replay" className="hover:text-[var(--accent)]">
            Replay
          </Link>
          <Link href="/traces?view=debug" className="hover:text-[var(--accent)]">
            Debugger
          </Link>
          <Link href="/observability/time-travel" className="hover:text-[var(--accent)]">
            Time-Travel
          </Link>
          <Link href="/traces?view=query" className="hover:text-[var(--accent)]">
            Query
          </Link>
        </div>
      </div>

      <div
        role="group"
        aria-label="Observability facets"
        className="flex flex-wrap gap-1.5"
      >
        {FACET_VIEWS.map((facet) => (
          <Link
            key={facet}
            href={`/traces?facet=${facet}`}
            className={cn(
              "inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium capitalize transition-colors",
              activeFacet === facet
                ? "border-[var(--accent)] bg-[var(--accent-faint)] text-[var(--accent)]"
                : "border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--accent)]/50 hover:text-[var(--text-primary)]",
            )}
          >
            {facet}
          </Link>
        ))}
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
            applyListFilters({
              realm: next.realm ?? "",
              outcome: next.outcome ?? "",
              agent_id: next.agent_id ?? "",
            })
          }
          query={query}
          onQueryChange={(q) => {
            setQuery(q);
            setUrlState({ q });
            writeFilterParams(filter, q);
          }}
          selects={[
            {
              key: "realm",
              label: "All realms",
              value: filter.realm ?? "",
              options: [
                { value: "environment", label: "Environment" },
                { value: "production", label: "Production" },
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
        {filter.agent_id ? (
          <span
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border-default)] px-2 py-1 text-xs text-[var(--text-secondary)]"
            data-testid="traces-agent-filter-chip"
          >
            agent:{filter.agent_id}
            <button
              type="button"
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              aria-label="Clear agent filter"
              onClick={() =>
                applyListFilters({ ...filter, agent_id: "" })
              }
            >
              ×
            </button>
          </span>
        ) : null}
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
            applyListFilters({ realm: "", outcome: "", agent_id: "" });
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
      {hubView === "traces" && (
        <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
          <div className="space-y-4 min-w-0">
            {showError ? (
              <ErrorState
                title="Could not load traces"
                message={errorMessage ?? "Unknown error"}
                action={
                  <Button onClick={refresh} variant="outline" loading={refreshing}>
                    Try again
                  </Button>
                }
              />
            ) : showFirstRunEmpty ? (
              <div data-testid="traces-first-run-hint">
                <WaitingForFirstEvent
                  onCheck={refresh}
                  checking={refreshing}
                  firstTraceAt={firstTraceAt}
                  secondaryActions={
                    <>
                      {canManageKeys ? (
                        <Button asChild variant="outline" className="min-h-11">
                          <Link href="/settings?tab=api-keys">
                            <Key className="h-4 w-4" />
                            API keys
                          </Link>
                        </Button>
                      ) : (
                        <Button asChild variant="outline" className="min-h-11">
                          <a href={DOCS_QUICKSTART_URL} target="_blank" rel="noopener noreferrer">
                            <BookOpen className="h-4 w-4" />
                            Docs quickstart
                          </a>
                        </Button>
                      )}
                      {canManageKeys ? (
                        <Button asChild variant="ghost" className="min-h-11">
                          <a href={DOCS_QUICKSTART_URL} target="_blank" rel="noopener noreferrer">
                            <BookOpen className="h-4 w-4" />
                            Docs quickstart
                          </a>
                        </Button>
                      ) : (
                        <span className="text-xs text-[var(--text-muted)] px-3 py-2">
                          Ask an admin for an API key
                        </span>
                      )}
                    </>
                  }
                />
              </div>
            ) : showFilteredEmpty ? (
              <div data-testid="traces-filtered-empty">
                <EmptyState
                  icon={Layers}
                  title="No traces match"
                  description="The list returned successfully with no rows for the current filters. Clear filters or widen the query."
                  size="lg"
                  action={
                    <Button
                      variant="outline"
                      className="min-h-11"
                      onClick={() => {
                        setQuery("");
                        applyListFilters({ realm: "", outcome: "", agent_id: "" });
                        applyView("");
                      }}
                    >
                      Clear filters
                    </Button>
                  }
                />
              </div>
            ) : (
              <>
                <SpanSearchBar orgId={currentOrg.id} onSelectTrace={handleSelectTrace} />
                <TracesTab
                  traces={traces}
                  loading={loading}
                  filter={effectiveFilter}
                  onFilterChange={applyListFilters}
                  onSelectTrace={handleSelectTrace}
                  onViewTimeline={handleViewTimeline}
                  onExport={handleExport}
                  onAnnotate={handleAnnotate}
                  onCreateAlertFromFilters={handleCreateAlertFromFilters}
                  initialTraceId={traceId || undefined}
                  hasMore={!loading && !showError && tracesTotal > traces.length}
                  onLoadMore={() => setOffset((o) => o + PAGE_SIZE)}
                  loadingMore={loadingMore}
                />
              </>
            )}
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
            router.push(`/sessions/${encodeURIComponent(sid)}`);
          }}
        />
      )}
    </>
  );

  return (
    <PageContent size="wide">
      <ResourcePageShell
        header={
          <PageHeader
            eyebrow="Observe"
            title="Traces"
            subtitle="Traces, spans, and sessions — shareable filters and inline transcript detail."
          />
        }
        toolbar={
          isLegacyView ? undefined : isFacetView ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Link href="/traces" className="text-[var(--accent)] hover:underline">
                  ← Traces
                </Link>
                <span className="text-[var(--text-muted)]">·</span>
                <span className="text-[var(--text-muted)]">Facets</span>
              </div>
              <div
                role="group"
                aria-label="Observability facets"
                className="flex flex-wrap gap-1.5"
              >
                {FACET_VIEWS.map((facet) => (
                  <Link
                    key={facet}
                    href={`/traces?facet=${facet}`}
                    className={cn(
                      "inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                      activeFacet === facet
                        ? "border-[var(--accent)] bg-[var(--accent-faint)] text-[var(--accent)]"
                        : "border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--accent)]/50 hover:text-[var(--text-primary)]",
                    )}
                  >
                    {facet}
                  </Link>
                ))}
              </div>
            </div>
          ) : (
            toolbar
          )
        }
        table={
          isLegacyView || isFacetView ? (
            <EmbeddedSurface>
              {hubView === "inspect" && <InspectView />}
              {hubView === "replay" && <ReplayView />}
              {hubView === "debug" && <DebugView />}
              {hubView === "query" && <QueryView />}
              {activeFacet === "mcp" && <McpFacetView />}
              {activeFacet === "decisions" && <DecisionsFacetView />}
              {activeFacet === "memory" && <MemoryFacetView />}
              {activeFacet === "retrieval" && <RetrievalFacetView />}
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
              <TraceDetailPanel
                traceId={traceId}
                highlightSpanId={spanId}
                onClose={handleCloseDetail}
              />
            </DetailPanelShell>
          ) : null
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
