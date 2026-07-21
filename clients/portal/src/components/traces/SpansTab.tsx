"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Columns3 } from "lucide-react";
import { InfiniteDataTable, useDensity } from "@/components/portal-os";
import type { DataTableColumn } from "@/components/ui/data-table";
import { api } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { parseQueryLanguage, parsedToSpanSearchParams } from "@/lib/query-language";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface SpansTabProps {
  orgId: string;
  query?: string;
  onSelectTrace: (traceId: string, spanId?: string) => void;
}

type SpanHit = {
  trace_id: string;
  span_id?: string;
  name?: string;
  snippet?: string;
  duration_ms?: number;
  outcome?: string;
};

const PAGE_SIZE = 50;

export const SPANS_OPTIONAL_COLUMNS = [
  { id: "snippet", label: "Preview" },
  { id: "trace_id", label: "Trace" },
] as const;

export const SPANS_DEFAULT_VISIBLE = ["snippet", "trace_id"] as const;

function hitKey(h: SpanHit): string {
  return `${h.trace_id}-${h.span_id ?? h.name ?? ""}`;
}

/**
 * Spans lens — shares hub toolbar grammar; hideable columns + compact density.
 */
export function SpansTab({ orgId, query, onSelectTrace }: SpansTabProps) {
  const density = useDensity();
  const [page, setPage] = useState(1);
  const [hits, setHits] = useState<SpanHit[]>([]);
  const [visibleOptional, setVisibleOptional] = useState<string[]>([
    ...SPANS_DEFAULT_VISIBLE,
  ]);

  const parsed = useMemo(() => parseQueryLanguage(query ?? ""), [query]);
  const searchParams = useMemo(() => parsedToSpanSearchParams(parsed), [parsed]);
  const queryKey = `${searchParams.q}|${searchParams.agent ?? ""}|${searchParams.outcome ?? ""}`;

  useEffect(() => {
    setPage(1);
    setHits([]);
  }, [queryKey]);

  const spansQuery = useOrgQuery(
    queryKeys.observability.spans(orgId, { q: query ?? "", page }),
    orgId,
    () =>
      api.searchSpans(orgId, {
        ...searchParams,
        per_page: PAGE_SIZE,
        page,
      }),
  );

  useEffect(() => {
    const pageHits = (spansQuery.data?.hits ?? []) as SpanHit[];
    if (!spansQuery.data) return;
    setHits((prev) => {
      if (page <= 1) return pageHits;
      const seen = new Set(prev.map(hitKey));
      const next = [...prev];
      for (const h of pageHits) {
        const k = hitKey(h);
        if (!seen.has(k)) {
          seen.add(k);
          next.push(h);
        }
      }
      return next;
    });
  }, [spansQuery.data, page]);

  const loadMore = useCallback(() => {
    setPage((p) => p + 1);
  }, []);

  const columns: DataTableColumn<SpanHit>[] = useMemo(() => {
    const cols: DataTableColumn<SpanHit>[] = [
      {
        key: "outcome",
        header: "",
        sortable: true,
        sticky: true,
        className: "w-10 max-w-10 px-0",
        headerClassName: "w-10 max-w-10 px-0",
        cell: (r) => {
          const color =
            r.outcome === "success"
              ? "bg-[var(--success)]"
              : r.outcome === "failure" || r.outcome === "crash"
                ? "bg-[var(--error)]"
                : r.outcome === "partial" || r.outcome === "timeout"
                  ? "bg-[var(--warning)]"
                  : "bg-[var(--text-muted)]";
          return (
            <div
              className="flex h-full w-10 items-center justify-center"
              data-testid="span-status-strip"
              role="status"
              aria-label={r.outcome ? `Outcome: ${r.outcome}` : "Outcome: unknown"}
            >
              <span className={`h-8 w-1 rounded-full ${color}`} aria-hidden />
            </div>
          );
        },
      },
      {
        key: "name",
        header: "Span",
        sortable: true,
        cell: (r) => (
          <span className="text-xs font-medium text-[var(--text-primary)]">
            {r.name ?? "—"}
          </span>
        ),
      },
      {
        key: "duration_ms",
        header: "Duration",
        sortable: true,
        align: "right",
        cell: (r) => (
          <span className="text-xs tabular-nums text-[var(--text-secondary)]">
            {r.duration_ms != null ? `${r.duration_ms.toFixed(0)}ms` : "—"}
          </span>
        ),
      },
    ];
    if (visibleOptional.includes("trace_id")) {
      cols.push({
        key: "trace_id",
        header: "Trace",
        sortable: true,
        cell: (r) => (
          <span className="font-mono text-xs text-[var(--text-muted)]">
            {r.trace_id.slice(0, 12)}…
          </span>
        ),
      });
    }
    if (visibleOptional.includes("snippet")) {
      cols.push({
        key: "snippet",
        header: "Preview",
        cell: (r) => (
          <span className="line-clamp-1 text-xs text-[var(--text-muted)]">
            {r.snippet ?? "—"}
          </span>
        ),
      });
    }
    return cols;
  }, [visibleOptional]);

  const total = spansQuery.data?.total ?? 0;
  const isFallback = spansQuery.data?.fallback === true;
  const listError = spansQuery.isError;
  const errorMessage = spansQuery.error?.message ?? null;

  return (
    <div
      className="space-y-space-2"
      data-testid="spans-table"
      data-density={density === "comfortable" ? "compact" : density}
    >
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-8"
              aria-label="Toggle span columns"
              data-testid="spans-columns-menu"
            >
              <Columns3 className="h-3.5 w-3.5" aria-hidden />
              Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Hideable columns</DropdownMenuLabel>
            {SPANS_OPTIONAL_COLUMNS.map((col) => {
              const checked = visibleOptional.includes(col.id);
              return (
                <DropdownMenuItem
                  key={col.id}
                  onSelect={(e) => {
                    e.preventDefault();
                    setVisibleOptional((prev) =>
                      checked ? prev.filter((id) => id !== col.id) : [...prev, col.id],
                    );
                  }}
                  aria-checked={checked}
                  data-testid={`spans-col-${col.id}`}
                >
                  {checked ? "✓ " : ""}
                  {col.label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {isFallback && !listError && (
        <p className="px-1 text-xs text-[var(--warning)]">
          Search index offline (PG fallback) — results may lag Typesense.
        </p>
      )}
      {listError ? (
        <ErrorState
          title="Could not load spans"
          message={errorMessage ?? "Unknown error"}
          action={
            <Button
              variant="outline"
              onClick={() => void spansQuery.refetch()}
              loading={spansQuery.isFetching}
            >
              Try again
            </Button>
          }
        />
      ) : (
        <InfiniteDataTable
          columns={columns}
          rows={hits}
          loading={spansQuery.isLoading && page === 1}
          rowKey={(r) => hitKey(r)}
          onRowClick={(r) => onSelectTrace(r.trace_id, r.span_id)}
          selectable
          defaultSort={{ key: "duration_ms", direction: "desc" }}
          emptyTitle="No spans match"
          emptyDescription="Try widening your query or time range. Use agent: / status: / text: tokens."
          hasMore={total > hits.length}
          onLoadMore={loadMore}
          loadingMore={spansQuery.isFetching && page > 1}
        />
      )}
    </div>
  );
}
