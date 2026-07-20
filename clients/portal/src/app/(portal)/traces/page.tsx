"use client";

/**
 * /traces — U01 Traces Hub: Traces | Spans | Sessions with split-pane detail.
 */

import { useCallback, useMemo, useState, Suspense, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { BookOpen, ChevronDown, Key, Layers, Radio, RefreshCw, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { NoOrgState } from "@/components/ui/no-org-state";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WaitingForFirstEvent } from "@/components/onboarding/WaitingForFirstEvent";
import {
  TracesTab,
  TRACES_OPTIONAL_COLUMNS,
  TRACES_DEFAULT_VISIBLE_OPTIONAL,
} from "../observability/_components/TracesTab";
import type { TraceFilter, TraceItem } from "../observability/_lib/types";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { api, onboardingV2Api } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { SpanSearchBar } from "./_components/SpanSearchBar";
import {
  ResourcePageShell,
  QueryFilterBar,
  ViewsMenu,
  DetailPanelShell,
  useResourceUrlState,
  useSavedViews,
  isViewDirty,
  type FilterMode,
} from "@/components/portal-os";
import { useQueryTab } from "@/hooks/use-query-tab";
import { parseQueryLanguage } from "@/lib/query-language";
import { usePagePerf, useTableQueryPerf, markEden } from "@/lib/perf";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { FIRST_EVENT_WAIT, U20_FILTER_EMPTY_COPY } from "@/lib/portal-polish";
import {
  deriveTracesListUi,
  filtersFromSearchParams,
} from "./traces-list-ui";

const HUB_VIEWS = ["traces", "spans", "sessions"] as const;
const LEGACY_VIEWS = ["inspect", "replay", "debug", "query", "time-travel"] as const;
const FACET_VIEWS = ["mcp", "decisions", "memory", "retrieval"] as const;
const ALL_VIEWS = [...HUB_VIEWS, ...LEGACY_VIEWS] as const;

const LEGACY_TOOL_LINKS = [
  { href: "/traces?view=inspect", label: "Inspector" },
  { href: "/traces?view=replay", label: "Replay" },
  { href: "/traces?view=debug", label: "Debugger" },
  { href: "/traces?view=time-travel", label: "Time-Travel" },
  { href: "/traces?view=query", label: "Query" },
] as const;

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
const TimeTravelView = dynamic(
  () => import("@/app/(portal)/observability/time-travel/page"),
  { ssr: false, loading: () => <ViewLoading /> },
);
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
/** LiveTail / export / annotate stay out of the traces hub first paint. */
const LiveTailPanel = dynamic(
  () =>
    import("./_components/LiveTailPanel").then((m) => ({
      default: m.LiveTailPanel,
    })),
  { ssr: false },
);
const TraceExportModal = dynamic(
  () =>
    import("../observability/_components/TraceExportModal").then((m) => ({
      default: m.TraceExportModal,
    })),
  { ssr: false },
);
const AnnotateTraceDialog = dynamic(
  () =>
    import("../observability/_components/AnnotateTraceDialog").then((m) => ({
      default: m.AnnotateTraceDialog,
    })),
  { ssr: false },
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
  const [hubView] = useQueryTab("view", ALL_VIEWS, "traces");
  const isLegacyView = (LEGACY_VIEWS as readonly string[]).includes(hubView);
  const facetParam = searchParams.get("facet");
  const activeFacet =
    facetParam && (FACET_VIEWS as readonly string[]).includes(facetParam)
      ? (facetParam as (typeof FACET_VIEWS)[number])
      : null;
  const isFacetView = activeFacet != null;
  const liveOn = searchParams.get("live") === "1";

  // Master–detail: canonical `?traceId=` (aliases read via useResourceUrlState).
  const traceId = urlState.traceId ?? "";
  const spanId = urlState.spanId;
  // Hub tabs use `view=`; saved views use canonical `viewId` (alias `savedView`).
  const savedViewId = urlState.viewId;

  const replaceSearchParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      const qs = params.toString();
      router.replace(`${window.location.pathname}${qs ? `?${qs}` : ""}`, {
        scroll: false,
      });
    },
    [router, searchParams],
  );

  const setLiveOn = useCallback(
    (on: boolean) => {
      replaceSearchParams((params) => {
        if (on) params.set("live", "1");
        else params.delete("live");
      });
    },
    [replaceSearchParams],
  );

  const selectHubView = useCallback(
    (next: (typeof HUB_VIEWS)[number]) => {
      replaceSearchParams((params) => {
        if (next === "traces") params.delete("view");
        else params.set("view", next);
        params.delete("facet");
      });
    },
    [replaceSearchParams],
  );

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
  const [tableSort, setTableSort] = useState<{
    key: string;
    direction: "asc" | "desc";
  } | null>({ key: "duration_ms", direction: "desc" });
  const [visibleColumns, setVisibleColumns] = useState<string[]>(() => {
    const raw = searchParams.get("cols");
    if (raw == null || raw === "") return [...TRACES_DEFAULT_VISIBLE_OPTIONAL];
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  });
  const [offset, setOffset] = useState(0);
  const [accumulated, setAccumulated] = useState<TraceItem[]>([]);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportTraceId, setExportTraceId] = useState("");
  const [annotateOpen, setAnnotateOpen] = useState(false);
  const [annotateTraceId, setAnnotateTraceId] = useState("");

  const setFacet = useCallback(
    (facet: string) => {
      replaceSearchParams((params) => {
        if (!facet) params.delete("facet");
        else params.set("facet", facet);
      });
    },
    [replaceSearchParams],
  );

  const writeVisibleColumns = useCallback(
    (next: string[]) => {
      setVisibleColumns(next);
      replaceSearchParams((params) => {
        const sameDefault =
          next.length === TRACES_DEFAULT_VISIBLE_OPTIONAL.length &&
          TRACES_DEFAULT_VISIBLE_OPTIONAL.every((id) => next.includes(id));
        if (sameDefault) params.delete("cols");
        else if (next.length === 0) params.set("cols", "");
        else params.set("cols", next.join(","));
      });
    },
    [replaceSearchParams],
  );

  // Re-hydrate when shareable filter params change (deep link / back nav).
  useEffect(() => {
    setFilter(filtersFromSearchParams(searchParams));
  }, [filterUrlKey, searchParams]);

  // Re-hydrate Display columns from `?cols=` on back/forward.
  const colsParam = searchParams.get("cols");
  useEffect(() => {
    if (colsParam == null) {
      setVisibleColumns([...TRACES_DEFAULT_VISIBLE_OPTIONAL]);
      return;
    }
    setVisibleColumns(
      colsParam === ""
        ? []
        : colsParam.split(",").map((s) => s.trim()).filter(Boolean),
    );
  }, [colsParam]);

  const { views, save, update, remove, resolveView } = useSavedViews("traces");
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

  // applyView hydrates filter/q into local state — do not re-merge savedState
  // here or dirty edits would be overwritten while the amber trigger stays on.
  const effectiveFilter = useMemo(() => {
    const base = { ...filter };
    const qParsed = parseQueryLanguage(query);
    if (qParsed.agent_id) base.agent_id = qParsed.agent_id;
    if (qParsed.outcome) base.outcome = qParsed.outcome;
    if (qParsed.realm) base.realm = qParsed.realm;
    return base;
  }, [filter, query]);

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

  // UX-P0-10: dirty when filters|sort|columns diverge from active saved view / Default
  const currentViewState = useMemo(
    () => ({
      q: query || undefined,
      filter: {
        realm: filter.realm ?? "",
        outcome: filter.outcome ?? "",
        agent_id: filter.agent_id ?? "",
      },
      sort: tableSort ?? undefined,
      columns: visibleColumns,
    }),
    [
      query,
      filter.realm,
      filter.outcome,
      filter.agent_id,
      tableSort,
      visibleColumns,
    ],
  );
  const filterDirty = isViewDirty(currentViewState, savedState);
  const hasListConstraints =
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
        if (hasListConstraints || q.state.error) return false;
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
      selectHubView("traces");
    },
    [setUrlState, selectHubView],
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
      const vs = viewId ? resolveView(viewId) : null;
      const nextFilter = {
        realm: "",
        outcome: "",
        agent_id: "",
        ...(vs?.filter ?? {}),
      };
      const nextQ = vs?.q ?? "";
      const nextCols = vs?.columns?.length
        ? vs.columns
        : [...TRACES_DEFAULT_VISIBLE_OPTIONAL];
      const nextSort = vs?.sort ?? { key: "duration_ms", direction: "desc" as const };
      setQuery(nextQ);
      setFilter(nextFilter);
      setVisibleColumns(nextCols);
      setTableSort(nextSort);
      replaceSearchParams((params) => {
        // Canonical viewId; strip legacy savedView alias.
        params.delete("savedView");
        if (!viewId) params.delete("viewId");
        else params.set("viewId", viewId);
        if (nextQ) params.set("q", nextQ);
        else params.delete("q");
        if (nextFilter.realm) params.set("realm", nextFilter.realm);
        else params.delete("realm");
        if (nextFilter.outcome) params.set("outcome", nextFilter.outcome);
        else params.delete("outcome");
        if (nextFilter.agent_id) params.set("agent_id", nextFilter.agent_id);
        else params.delete("agent_id");
        const sameDefault =
          nextCols.length === TRACES_DEFAULT_VISIBLE_OPTIONAL.length &&
          TRACES_DEFAULT_VISIBLE_OPTIONAL.every((id) => nextCols.includes(id));
        if (!viewId || sameDefault) params.delete("cols");
        else params.set("cols", nextCols.join(","));
      });
    },
    [resolveView, replaceSearchParams],
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
    <div
      className="flex flex-wrap items-end gap-2"
      data-testid="traces-toolbar"
      data-chrome-band="toolbar"
    >
      <Tabs
        value={
          (HUB_VIEWS as readonly string[]).includes(hubView) ? hubView : "traces"
        }
        onValueChange={(v) => selectHubView(v as (typeof HUB_VIEWS)[number])}
        className="min-w-0"
      >
        <TabsList
          variant="underline"
          aria-label="Observe hub"
          className="h-auto flex-wrap justify-start gap-1 bg-transparent"
        >
          {HUB_VIEWS.map((v) => (
            <TabsTrigger
              key={v}
              variant="underline"
              value={v}
              title={v}
              className="min-h-11 capitalize"
            >
              {v}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <QueryFilterBar
        mode={filterMode}
        onModeChange={setFilterMode}
        filters={{
          realm: filter.realm ?? "",
          outcome: filter.outcome ?? "",
          agent_id: filter.agent_id ?? "",
          facet: activeFacet ?? "",
        }}
        onFiltersChange={(next) => {
          const nextFacet = next.facet ?? "";
          if (nextFacet !== (activeFacet ?? "")) {
            setFacet(nextFacet);
          }
          applyListFilters({
            realm: next.realm ?? "",
            outcome: next.outcome ?? "",
            agent_id: next.agent_id ?? "",
          });
        }}
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
          {
            key: "facet",
            label: "Facets",
            value: activeFacet ?? "",
            options: FACET_VIEWS.map((facet) => ({
              value: facet,
              label: facet.charAt(0).toUpperCase() + facet.slice(1),
            })),
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
            state: currentViewState,
          });
        }}
        onSaveChanges={
          savedViewId
            ? async () => {
                await update({
                  viewId: savedViewId,
                  state: currentViewState,
                });
              }
            : undefined
        }
        onDiscard={() => {
          if (savedViewId) {
            applyView(savedViewId);
            return;
          }
          applyView("");
        }}
        onDelete={async (id) => remove(id)}
      />
      <Button
        type="button"
        variant={liveOn ? "default" : "outline"}
        size="default"
        className="min-h-11"
        aria-pressed={liveOn}
        aria-label={liveOn ? "Turn off live tail" : "Turn on live tail"}
        onClick={() => setLiveOn(!liveOn)}
      >
        <Radio className="h-4 w-4" aria-hidden />
        Live
      </Button>
      <Button
        variant="outline"
        size="default"
        onClick={refresh}
        loading={refreshing}
        aria-label="Refresh traces"
      >
        <RefreshCw className="w-4 h-4" aria-hidden />
        Refresh
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="default"
            className="min-h-11"
            aria-label="More tools and display"
          >
            More
            <ChevronDown className="h-4 w-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[12rem]">
          <DropdownMenuLabel>Tools</DropdownMenuLabel>
          {LEGACY_TOOL_LINKS.map((item) => (
            <DropdownMenuItem key={item.href} asChild>
              <Link href={item.href}>{item.label}</Link>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Display</DropdownMenuLabel>
          {TRACES_OPTIONAL_COLUMNS.map((col) => {
            const checked = visibleColumns.includes(col.id);
            return (
              <DropdownMenuItem
                key={col.id}
                onSelect={(e) => {
                  e.preventDefault();
                  const next = checked
                    ? visibleColumns.filter((id) => id !== col.id)
                    : [...visibleColumns, col.id];
                  writeVisibleColumns(next);
                }}
                aria-checked={checked}
                data-testid={`display-col-${col.id}`}
              >
                {checked ? "✓ " : ""}
                {col.label}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const tableContent = (
    <>
      {hubView === "traces" && (
        <div
          className={
            liveOn
              ? "grid gap-4 lg:grid-cols-[1fr_18rem]"
              : "space-y-4"
          }
        >
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
                  description={U20_FILTER_EMPTY_COPY.traces}
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
                  onSelectTrace={handleSelectTrace}
                  onViewTimeline={handleViewTimeline}
                  onExport={handleExport}
                  onAnnotate={handleAnnotate}
                  initialTraceId={traceId || undefined}
                  hasMore={!loading && !showError && tracesTotal > traces.length}
                  onLoadMore={() => setOffset((o) => o + PAGE_SIZE)}
                  loadingMore={loadingMore}
                  visibleColumns={visibleColumns}
                  defaultSort={tableSort ?? undefined}
                  onSortChange={setTableSort}
                />
              </>
            )}
          </div>
          {liveOn ? (
            <LiveTailPanel
              orgId={currentOrg.id}
              enabled
              onSelectTrace={handleSelectTrace}
            />
          ) : null}
        </div>
      )}
      {hubView === "spans" && orgId && (
        <SpansTab orgId={orgId} query={query} onSelectTrace={handleSelectTrace} />
      )}
      {hubView === "sessions" && orgId && (
        <SessionsTab
          orgId={orgId}
          agentId={effectiveFilter.agent_id || undefined}
          outcome={effectiveFilter.outcome || undefined}
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
        toolbar={isLegacyView ? undefined : toolbar}
        table={
          isLegacyView || isFacetView ? (
            <EmbeddedSurface>
              {hubView === "inspect" && <InspectView />}
              {hubView === "replay" && <ReplayView />}
              {hubView === "debug" && <DebugView />}
              {hubView === "query" && <QueryView />}
              {hubView === "time-travel" && <TimeTravelView />}
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
                hideCloseControl
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
