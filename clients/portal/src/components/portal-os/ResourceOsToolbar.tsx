"use client";

import { useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import {
  QueryFilterBar,
  type FilterMode,
  type QueryFilterBarProps,
} from "./QueryFilterBar";
import { ViewsMenu } from "./ViewsMenu";
import { useSavedViews } from "./useSavedViews";
import { useResourceUrlState } from "./useResourceUrlState";
import { TableExportToolbar } from "./TableExportToolbar";
import { cn } from "@/lib/utils";

export interface ResourceOsToolbarProps {
  /** Saved-views storage key (e.g. "issues", "alerts"). */
  resourceKey: string;
  selects?: QueryFilterBarProps["selects"];
  searchPlaceholder?: string;
  onCreateAlert?: () => void;
  exportRows?: Array<Record<string, unknown>>;
  exportFilename?: string;
  exportColumns?: string[];
  className?: string;
  children?: ReactNode;
}

/**
 * Shared Filter + Views + optional CSV/JSONL export for resource hubs.
 * Syncs `?q=` / `?view=` via useResourceUrlState.
 */
export function ResourceOsToolbar({
  resourceKey,
  selects = [],
  onCreateAlert,
  exportRows,
  exportFilename,
  exportColumns,
  className,
  children,
}: ResourceOsToolbarProps) {
  const searchParams = useSearchParams();
  const { state, setState } = useResourceUrlState();
  const savedViewId = searchParams.get("view") ?? undefined;
  const { views, save, remove, resolveView } = useSavedViews(resourceKey);

  const [mode, setMode] = useState<FilterMode>("basic");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [query, setQuery] = useState(state.q ?? "");

  const filterDirty = Boolean(query) || Object.values(filters).some(Boolean);

  const applyView = (viewId: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (!viewId) params.delete("view");
    else params.set("view", viewId);
    const vs = resolveView(viewId);
    if (vs?.q) {
      setQuery(vs.q);
      params.set("q", vs.q);
      setState({ q: vs.q });
    }
    if (vs?.filter) setFilters((f) => ({ ...f, ...vs.filter }));
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  };

  return (
    <div className={cn("flex flex-wrap items-start gap-3", className)}>
      <QueryFilterBar
        mode={mode}
        onModeChange={setMode}
        filters={filters}
        onFiltersChange={setFilters}
        query={query}
        onQueryChange={(q) => {
          setQuery(q);
          setState({ q: q || undefined });
        }}
        selects={selects}
        onCreateAlert={onCreateAlert}
        className="flex-1 min-w-[16rem]"
      />
      <ViewsMenu
        views={views}
        activeViewId={savedViewId}
        dirty={filterDirty}
        onSelect={applyView}
        onSave={async (name) => {
          await save({ name, state: { q: query, filter: { ...filters } } });
        }}
        onDiscard={() => {
          setQuery("");
          setFilters({});
          setState({ q: undefined });
          applyView("");
        }}
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
