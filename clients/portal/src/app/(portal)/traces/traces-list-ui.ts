import type { TraceFilter } from "../observability/_lib/types";

/** Hydrate list filters from shareable URL params (drift drill-down, alerts). */
export function filtersFromSearchParams(sp: {
  get(name: string): string | null;
}): TraceFilter {
  return {
    realm: sp.get("realm") ?? "",
    outcome: sp.get("outcome") ?? "",
    agent_id: sp.get("agent_id") ?? "",
  };
}

/**
 * Empty vs error vs filtered-empty gate for the traces list.
 * HTTP 200 with `{ traces: [] }` is honest empty only after settlement.
 */
export function deriveTracesListUi(opts: {
  isLoading: boolean;
  isFetched: boolean;
  isError: boolean;
  accumulatedCount: number;
  filterDirty: boolean;
}): {
  loading: boolean;
  showError: boolean;
  showFirstRunEmpty: boolean;
  showFilteredEmpty: boolean;
} {
  const loading = opts.isLoading && opts.accumulatedCount === 0;
  const showError = opts.isError && !loading;
  const listReady =
    opts.isFetched && !opts.isError && !loading && opts.accumulatedCount === 0;
  return {
    loading,
    showError,
    showFirstRunEmpty: listReady && !opts.filterDirty,
    showFilteredEmpty: listReady && opts.filterDirty,
  };
}
