"use client";

/**
 * Traces hub state + data (Wave 3 split — keeps page.tsx ≤400 LOC).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  TRACES_DEFAULT_VISIBLE_OPTIONAL,
} from "../../observability/_components/TracesTab";
import type { TraceFilter, TraceItem } from "../../observability/_lib/types";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { api, onboardingV2Api } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import {
  useResourceUrlState,
  useSavedViews,
  isViewDirty,
  writeMasterDetailParam,
  type FilterMode,
} from "@/components/portal-os";
import { useQueryTab } from "@/hooks/use-query-tab";
import { parseQueryLanguage } from "@/lib/query-language";
import { usePagePerf, useTableQueryPerf, markEden } from "@/lib/perf";
import { FIRST_EVENT_WAIT } from "@/lib/portal-polish";
import { useListKeyboardNav } from "@/hooks/use-list-keyboard-nav";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import {
  deriveTracesListUi,
  filtersFromSearchParams,
} from "../traces-list-ui";
import {
  HUB_VIEWS,
  FACET_VIEWS,
  type HubView,
} from "./TracesToolbar";
import {
  TRACES_BUILTIN_VIEW_PRESETS,
  resolveTracesBuiltinView,
} from "./trace-builtin-views";

const LEGACY_VIEWS = ["inspect", "replay", "debug", "query", "time-travel"] as const;
const ALL_VIEWS = [...HUB_VIEWS, ...LEGACY_VIEWS] as const;
export const DETAIL_MODES = [
  "transcript",
  "tree",
  "timeline",
  "meta",
  "scores",
] as const;
export type DetailMode = (typeof DETAIL_MODES)[number];

const PAGE_SIZE = 50;

export function useTracesHub() {
  const {
    currentOrg,
    authError,
    orgSyncing,
    orgSyncTimedOut,
    refreshOrgs,
    loading: orgLoading,
  } = useOrg();
  const { hasPermission } = usePermissions();
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
  const modeParam = searchParams.get("mode");
  const detailMode: DetailMode =
    modeParam && (DETAIL_MODES as readonly string[]).includes(modeParam)
      ? (modeParam as DetailMode)
      : "transcript";

  const traceId = urlState.traceId ?? "";
  const spanId = urlState.spanId;
  const savedViewId = urlState.viewId;
  /** Default 168h = 7d when URL omits pastHours. */
  const pastHours = urlState.pastHours ?? "168";
  const listDays = Math.max(1, Math.ceil((Number(pastHours) || 168) / 24));

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

  const setPastHours = useCallback(
    (hours: string) => {
      setUrlState({
        pastHours: hours === "168" ? undefined : hours,
      });
    },
    [setUrlState],
  );

  const selectHubView = useCallback(
    (next: HubView) => {
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

  useEffect(() => {
    setFilter(filtersFromSearchParams(searchParams));
  }, [filterUrlKey, searchParams]);

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
  const resolveAnyView = useCallback(
    (viewId: string | undefined) => {
      if (!viewId) return null;
      return resolveTracesBuiltinView(viewId) ?? resolveView(viewId);
    },
    [resolveView],
  );
  const savedState = resolveAnyView(savedViewId);
  const hydratedViewRef = useRef<string | null>(null);

  // Hydrate once per viewId from URL / builtin / saved view (share round-trip).
  useEffect(() => {
    if (!savedViewId) {
      hydratedViewRef.current = null;
      return;
    }
    if (hydratedViewRef.current === savedViewId) return;
    const vs = resolveAnyView(savedViewId);
    if (!vs) return;
    hydratedViewRef.current = savedViewId;
    const nextQ = vs.q ?? "";
    const nextFilter = {
      realm: "",
      outcome: "",
      agent_id: "",
      ...(vs.filter ?? {}),
    };
    if (vs.q != null) setQuery(nextQ);
    setFilter(nextFilter);
    if (vs.sort) setTableSort(vs.sort);
    if (vs.columns) setVisibleColumns(vs.columns);
    // Mirror filter into URL so the URL↔state effect does not wipe hydrate.
    replaceSearchParams((params) => {
      if (nextQ) params.set("q", nextQ);
      else if (vs.q != null) params.delete("q");
      if (nextFilter.realm) params.set("realm", nextFilter.realm);
      else params.delete("realm");
      if (nextFilter.outcome) params.set("outcome", nextFilter.outcome);
      else params.delete("outcome");
      if (nextFilter.agent_id) params.set("agent_id", nextFilter.agent_id);
      else params.delete("agent_id");
    });
  }, [savedViewId, resolveAnyView, replaceSearchParams]);

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
        pastHours,
      }),
    [
      effectiveFilter.realm,
      effectiveFilter.outcome,
      effectiveFilter.agent_id,
      query,
      savedViewId,
      pastHours,
    ],
  );

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
      days: listDays,
      limit: PAGE_SIZE,
      offset: pageOffset,
    }),
    [effectiveFilter, pageOffset, listDays],
  );

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
    Boolean(
      effectiveFilter.realm ||
        effectiveFilter.outcome ||
        effectiveFilter.agent_id,
    ) || Boolean(savedViewId);

  const tracesQuery = useOrgQuery(
    queryKeys.observability.traces(orgId, traceFilterParams),
    orgId,
    () => api.listObservabilityTraces(orgId!, traceFilterParams),
    {
      refetchInterval: (q) => {
        if (hasListConstraints || q.state.error) return false;
        const data = q.state.data;
        if (!data) return false;
        const total = data.total ?? data.traces?.length ?? 0;
        return total === 0 ? FIRST_EVENT_WAIT.pollMs : false;
      },
    },
  );

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
    // Filtered-empty when any list constraint is active (not only dirty-vs-view).
    filterDirty: hasListConstraints,
  });
  const { loading, showError, showFirstRunEmpty, showFilteredEmpty } = listUi;

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
      refetchInterval: false,
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

  const traceIndex = traceId ? traces.findIndex((t) => t.trace_id === traceId) : -1;
  useListKeyboardNav(
    traces.length,
    traceIndex >= 0 ? traceIndex : 0,
    (idx) => {
      const row = traces[idx];
      if (row) handleSelectTrace(row.trace_id);
    },
    hubView === "traces" && traces.length > 0,
  );

  const handleCloseDetail = useCallback(() => {
    replaceSearchParams((params) => {
      writeMasterDetailParam(params, "traceId", undefined);
      writeMasterDetailParam(params, "spanId", undefined);
      params.delete("mode");
    });
  }, [replaceSearchParams]);

  /** Wave 6: `/` → filter focus (not ⌘K); Esc closes detail when shell may not own it. */
  useKeyboardShortcuts(
    {
      "/": () => {
        const el = document.querySelector<HTMLInputElement>(
          '[data-testid="query-filter-bar"] [data-filter-search]',
        );
        el?.focus();
        el?.select?.();
      },
      Escape: () => {
        if (traceId) handleCloseDetail();
      },
    },
    hubView === "traces",
  );

  const handleViewTimeline = useCallback(
    (id: string) => {
      replaceSearchParams((params) => {
        writeMasterDetailParam(params, "traceId", id);
        writeMasterDetailParam(params, "spanId", undefined);
        params.set("mode", "timeline");
        params.delete("view");
        params.delete("facet");
      });
    },
    [replaceSearchParams],
  );

  const handleViewTree = useCallback(
    (id: string) => {
      replaceSearchParams((params) => {
        writeMasterDetailParam(params, "traceId", id);
        writeMasterDetailParam(params, "spanId", undefined);
        params.set("mode", "tree");
        params.delete("view");
        params.delete("facet");
      });
    },
    [replaceSearchParams],
  );

  const handleDetailModeChange = useCallback(
    (mode: DetailMode) => {
      replaceSearchParams((params) => {
        if (mode === "transcript") params.delete("mode");
        else params.set("mode", mode);
      });
    },
    [replaceSearchParams],
  );

  const handleSelectSpan = useCallback(
    (nextSpanId: string | null) => {
      setUrlState({
        spanId: nextSpanId || undefined,
      });
    },
    [setUrlState],
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
      if (pastHours) params.set("pastHours", pastHours);
      if (query) params.set("q", query);
      router.push(`/alerts?${params.toString()}`);
    },
    [router, pastHours, query],
  );

  const applyView = useCallback(
    (viewId: string) => {
      const vs = viewId ? resolveAnyView(viewId) : null;
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
      hydratedViewRef.current = viewId || null;
      setQuery(nextQ);
      setFilter(nextFilter);
      setVisibleColumns(nextCols);
      setTableSort(nextSort);
      replaceSearchParams((params) => {
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
    [resolveAnyView, replaceSearchParams],
  );

  return {
    currentOrg,
    authError,
    orgSyncing,
    orgSyncTimedOut,
    refreshOrgs,
    orgLoading,
    canManageKeys,
    orgId,
    hubView,
    isLegacyView,
    activeFacet,
    isFacetView,
    liveOn,
    detailMode,
    traceId,
    spanId,
    savedViewId,
    pastHours,
    setPastHours,
    setLiveOn,
    selectHubView,
    filterMode,
    setFilterMode,
    filter,
    query,
    setQuery,
    setUrlState,
    writeFilterParams,
    applyListFilters,
    effectiveFilter,
    visibleColumns,
    writeVisibleColumns,
    tableSort,
    setTableSort,
    views,
    viewPresets: TRACES_BUILTIN_VIEW_PRESETS,
    save,
    update,
    remove,
    filterDirty,
    currentViewState,
    applyView,
    traces,
    tracesTotal,
    refreshing,
    loadingMore,
    errorMessage,
    loading,
    showError,
    showFirstRunEmpty,
    showFilteredEmpty,
    firstTraceAt,
    refresh,
    handleSelectTrace,
    handleCloseDetail,
    handleViewTimeline,
    handleViewTree,
    handleDetailModeChange,
    handleSelectSpan,
    handleExport,
    handleAnnotate,
    handleCreateAlertFromFilters,
    exportOpen,
    setExportOpen,
    exportTraceId,
    annotateOpen,
    setAnnotateOpen,
    annotateTraceId,
    setOffset,
    PAGE_SIZE,
  };
}

export type TracesHubState = ReturnType<typeof useTracesHub>;
