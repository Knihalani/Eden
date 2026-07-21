"use client";

/**
 * Hub adoption (Wave 1.7):
 * - List hubs MUST use QueryState for loading / error / empty / filter-empty.
 * - Ban new bare EmptyState as the sole hub shell without QueryState.
 * - EmptyState remains the emptySlot / nested empty UI inside QueryState.
 *
 * Adopted list hubs (current): /issues, /alerts, /agents, /fleet,
 * /datasets, /labeling, /incidents, /signals, /audit-trail, and peers
 * that already wrap list queries in QueryState. Detail / non-list
 * surfaces may still use EmptyState alone when there is no list query.
 */

import type { ReactNode } from "react";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Empty taxonomy from w3-component-contract §5. */
export type QueryEmptyKind = "zero-data" | "filter-empty" | "period-empty";

export function resolveEmptySlot({
  filtersActive,
  emptySlot,
  filterEmptySlot,
}: {
  filtersActive?: boolean;
  emptySlot?: ReactNode;
  filterEmptySlot?: ReactNode;
}): ReactNode {
  if (filtersActive && filterEmptySlot != null) {
    return filterEmptySlot;
  }
  return emptySlot;
}

interface QueryStateProps<T> {
  /** ``isLoading`` from ``useApiQuery``/``useOrgQuery`` — true only
   *  on the very first fetch (no cached data yet). */
  loading: boolean;
  /** ``error`` from the query. Falsy means no error. */
  error: Error | null | undefined;
  /** The query's ``data``. Used for the emptiness check below. */
  data: T | null | undefined;
  /** Retry handler — usually the query's ``refetch``. */
  onRetry?: () => void;
  /** Returns true when ``data`` should render the empty slot instead
   *  of ``children`` (e.g. ``(d) => (d?.items.length ?? 0) === 0``).
   *  Omit to skip the empty check entirely. */
  isEmpty?: (data: T) => boolean;
  /** Rendered while ``loading`` is true. Defaults to a generic
   *  3-line skeleton card. */
  loadingSlot?: ReactNode;
  /** Rendered when ``isEmpty`` returns true (and filter-empty does
   *  not take precedence). */
  emptySlot?: ReactNode;
  /**
   * Prefer this over ``emptySlot`` when ``filtersActive`` is true and
   * the result set is empty (filter-empty taxonomy).
   */
  filterEmptySlot?: ReactNode;
  /** True when the user has active filters that could empty the set. */
  filtersActive?: boolean;
  /**
   * Documents which empty taxonomy is shown. Emitted as
   * ``data-empty-kind`` on the empty wrapper when the empty path renders.
   */
  emptyKind?: QueryEmptyKind;
  /** Error copy passed through to ``ErrorState``. */
  errorTitle?: string;
  className?: string;
  children: (data: T) => ReactNode;
}

/**
 * QueryState — mechanical loading → error+retry → empty → children
 * shell for a single React Query result. Required shell for list hubs
 * (see file-top adoption block). Pass EmptyState via emptySlot /
 * filterEmptySlot — do not replace this shell with bare EmptyState.
 *
 * Usage:
 *   const query = useOrgQuery(queryKeys.agents.list(orgId), orgId, () => agentsApi.list(orgId!));
 *   <QueryState {...query} isEmpty={(d) => d.agents.length === 0} emptySlot={<EmptyState .../>}>
 *     {(data) => <AgentGrid agents={data.agents} />}
 *   </QueryState>
 *
 * Not a replacement for ``NoOrgState`` — callers still guard the
 * org-less case themselves (before org id exists there's nothing to
 * query yet, which is a different state than "query failed").
 */
export function QueryState<T>({
  loading,
  error,
  data,
  onRetry,
  isEmpty,
  loadingSlot,
  emptySlot,
  filterEmptySlot,
  filtersActive,
  emptyKind,
  errorTitle = "Could not load this data",
  className,
  children,
}: QueryStateProps<T>) {
  if (loading) {
    return (
      <div
        className={cn(className)}
        data-query-state="loading"
        aria-busy="true"
        aria-live="polite"
      >
        {loadingSlot ?? (
          <div className="space-y-2 p-1">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="contents" data-query-state="error">
        <ErrorState
          title={errorTitle}
          message={error.message}
          className={className}
          onRetry={onRetry}
        />
      </div>
    );
  }

  if (data == null) return null;

  if (isEmpty?.(data)) {
    const resolved = resolveEmptySlot({
      filtersActive,
      emptySlot,
      filterEmptySlot,
    });
    const kind =
      emptyKind ??
      (filtersActive && filterEmptySlot != null ? "filter-empty" : undefined);
    return (
      <div
        className={cn(className)}
        data-query-state="empty"
        data-empty-kind={kind}
      >
        {resolved}
      </div>
    );
  }

  return (
    <div className="contents" data-query-state="ready">
      {children(data)}
    </div>
  );
}
