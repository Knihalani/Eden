"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import {
  QueryFilterBar,
  type FilterMode,
  type QueryFilterBarProps,
} from "./QueryFilterBar";
import { ViewsMenu } from "./ViewsMenu";
import type { ViewPreset } from "./ViewsMenu";
import { isViewDirty, useSavedViews, type ViewState } from "./useSavedViews";
import { useResourceUrlState } from "./useResourceUrlState";
import { readMasterDetailParam, writeMasterDetailParam } from "./CoreResourcePage";
import { TableExportToolbar } from "./TableExportToolbar";
import { cn } from "@/lib/utils";

export interface ResourceOsToolbarProps {
  /** Saved-views storage key (e.g. "issues", "alerts", "traces"). */
  resourceKey: string;
  selects?: QueryFilterBarProps["selects"];
  searchPlaceholder?: string;
  onCreateAlert?: () => void;
  exportRows?: Array<Record<string, unknown>>;
  exportFilename?: string;
  exportColumns?: string[];
  /** Optional current sort — participates in dirty detection (§C.2). */
  sort?: ViewState["sort"];
  /** Optional visible column ids — participates in dirty detection (§C.2). */
  columns?: string[];
  /**
   * Hub list filter sync — called whenever toolbar filters change
   * (chip edits, saved-view apply, discard). Keys match `selects[].key`.
   */
  onFiltersChange?: (filters: Record<string, string>) => void;
  /** Built-in status/filter presets (Issues Wave 5 — status as saved views). */
  viewPresets?: ViewPreset[];
  /** Stick filter toolbar under shell header (`h-11`). */
  sticky?: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * Shared Filter + Views + optional CSV/JSONL export for resource hubs.
 * Syncs `?q=` / `?viewId=` (alias `?savedView=`) via URL.
 * Hub tab lens stays on `?view=` (reserved).
 *
 * Dirty amber when filters OR sort OR columns diverge from the active saved view.
 */
export function ResourceOsToolbar({
  resourceKey,
  selects = [],
  onCreateAlert,
  exportRows,
  exportFilename,
  exportColumns,
  sort,
  columns,
  onFiltersChange,
  viewPresets = [],
  sticky = false,
  className,
  children,
}: ResourceOsToolbarProps) {
  const searchParams = useSearchParams();
  const { state, setState } = useResourceUrlState();
  const savedViewId =
    readMasterDetailParam(searchParams, "viewId") ?? state.viewId ?? undefined;
  const { views, save, update, remove, resolveView } = useSavedViews(resourceKey);

  const [mode, setMode] = useState<FilterMode>("basic");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [query, setQuery] = useState(state.q ?? "");
  const hydratedViewRef = useRef<string | null>(null);
  const onFiltersChangeRef = useRef(onFiltersChange);
  onFiltersChangeRef.current = onFiltersChange;

  const resolveAnyView = (viewId: string | undefined): ViewState | null => {
    if (!viewId) return null;
    const preset = viewPresets.find((p) => p.id === viewId);
    if (preset) return preset.state;
    return resolveView(viewId);
  };

  const pushFilters = (next: Record<string, string>) => {
    setFilters(next);
    onFiltersChangeRef.current?.(next);
  };

  // Hydrate once per viewId from URL / saved view / status preset (share round-trip).
  useEffect(() => {
    if (!savedViewId) {
      hydratedViewRef.current = null;
      return;
    }
    if (hydratedViewRef.current === savedViewId) return;
    const vs = resolveAnyView(savedViewId);
    if (!vs) return;
    hydratedViewRef.current = savedViewId;
    setQuery(vs.q ?? "");
    const nextFilter = vs.filter ? { ...vs.filter } : {};
    setFilters(nextFilter);
    onFiltersChangeRef.current?.(nextFilter);
    if (vs.q) setState({ q: vs.q });
    // resolveAnyView is stable via viewPresets + resolveView
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional hydrate-once
  }, [savedViewId, resolveView, setState, viewPresets]);

  // Hub EmptyState / KPI clears update parent state — mirror select values back in.
  const selectValueKey = selects.map((s) => `${s.key}:${s.value ?? ""}`).join("|");
  useEffect(() => {
    if (selects.length === 0) return;
    setFilters((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const s of selects) {
        const v = s.value ?? "";
        if ((next[s.key] ?? "") !== v) {
          next[s.key] = v;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // selectValueKey captures value changes without identity churn on `selects`.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional fingerprint
  }, [selectValueKey]);

  const currentViewState = useMemo<ViewState>(
    () => ({
      q: query || undefined,
      filter: { ...filters },
      sort,
      columns,
    }),
    [query, filters, sort, columns],
  );

  const baseline = resolveAnyView(savedViewId);
  const viewsDirty = isViewDirty(currentViewState, baseline);

  // Select values always mirror filter state so dirty + chips stay honest.
  const resolvedSelects = useMemo(
    () =>
      selects.map((s) => ({
        ...s,
        value: filters[s.key] ?? s.value ?? "",
      })),
    [selects, filters],
  );

  const applyView = (viewId: string) => {
    const params = new URLSearchParams(searchParams.toString());
    writeMasterDetailParam(params, "viewId", viewId || undefined);
    const vs = resolveAnyView(viewId);
    hydratedViewRef.current = viewId || null;
    if (vs?.q) {
      setQuery(vs.q);
      params.set("q", vs.q);
      setState({ q: vs.q });
    } else if (!viewId) {
      setQuery("");
      params.delete("q");
      setState({ q: undefined });
    }
    const nextFilter = vs?.filter ? { ...vs.filter } : {};
    if (!viewId) {
      // Clear known select keys so hub lists reset to "all".
      for (const s of selects) nextFilter[s.key] = "";
    }
    pushFilters(nextFilter);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  };

  const discardToBaseline = () => {
    if (savedViewId && baseline) {
      setQuery(baseline.q ?? "");
      const nextFilter = baseline.filter ? { ...baseline.filter } : {};
      pushFilters(nextFilter);
      setState({ q: baseline.q || undefined });
      applyView(savedViewId);
      return;
    }
    setQuery("");
    const cleared: Record<string, string> = {};
    for (const s of selects) cleared[s.key] = "";
    pushFilters(cleared);
    setState({ q: undefined });
    applyView("");
  };

  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-space-3",
        sticky && "sticky top-11 z-10 bg-[var(--bg-primary)] py-space-2",
        className,
      )}
      data-testid={`${resourceKey}-views-os`}
    >
      <QueryFilterBar
        mode={mode}
        onModeChange={setMode}
        filters={filters}
        onFiltersChange={pushFilters}
        query={query}
        onQueryChange={(q) => {
          setQuery(q);
          setState({ q: q || undefined });
        }}
        selects={resolvedSelects}
        onCreateAlert={onCreateAlert}
        className="flex-1 min-w-[16rem]"
      />
      <ViewsMenu
        views={views}
        presets={viewPresets}
        activeViewId={savedViewId}
        dirty={viewsDirty}
        onSelect={applyView}
        onSave={async (name) => {
          await save({ name, state: currentViewState });
        }}
        onSaveChanges={
          savedViewId && !viewPresets.some((p) => p.id === savedViewId)
            ? async () => {
                await update({ viewId: savedViewId, state: currentViewState });
              }
            : undefined
        }
        onDiscard={discardToBaseline}
        onDelete={async (id) => remove(id)}
      />
      {exportRows && exportFilename ? (
        <TableExportToolbar
          rows={exportRows}
          filename={exportFilename}
          columns={exportColumns as Array<keyof (typeof exportRows)[number]> | undefined}
        />
      ) : null}
      {children}
    </div>
  );
}
