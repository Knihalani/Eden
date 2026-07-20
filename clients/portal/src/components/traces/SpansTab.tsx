"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { InfiniteDataTable } from "@/components/portal-os";
import type { DataTableColumn } from "@/components/ui/data-table";
import { api } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { TraceOutcomeBadge } from "@/components/ui/status-badge";
import { parseQueryLanguage, parsedToSpanSearchParams } from "@/lib/query-language";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";

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

function hitKey(h: SpanHit): string {
  return `${h.trace_id}-${h.span_id ?? h.name ?? ""}`;
}

export function SpansTab({ orgId, query, onSelectTrace }: SpansTabProps) {
  const [page, setPage] = useState(1);
  const [hits, setHits] = useState<SpanHit[]>([]);

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

  const columns: DataTableColumn<SpanHit>[] = useMemo(
    () => [
      {
        key: "name",
        header: "Span",
        cell: (r) => (
          <span className="text-xs font-medium text-[var(--text-primary)]">
            {r.name ?? "—"}
          </span>
        ),
      },
      {
        key: "trace_id",
        header: "Trace",
        cell: (r) => (
          <span className="font-mono text-xs text-[var(--text-muted)]">
            {r.trace_id.slice(0, 12)}…
          </span>
        ),
      },
      {
        key: "outcome",
        header: "Status",
        cell: (r) => <TraceOutcomeBadge outcome={r.outcome ?? null} />,
      },
      {
        key: "snippet",
        header: "Preview",
        cell: (r) => (
          <span className="text-xs text-[var(--text-muted)] line-clamp-1">
            {r.snippet ?? "—"}
          </span>
        ),
      },
    ],
    [],
  );

  const total = spansQuery.data?.total ?? 0;
  const isFallback = spansQuery.data?.fallback === true;
  const alertHref = `/alerts?tab=rules&q=${encodeURIComponent(query ?? "")}`;
  const listError = spansQuery.isError;
  const errorMessage = spansQuery.error?.message ?? null;

  return (
    <div className="space-y-2">
      {isFallback && !listError && (
        <p className="text-[11px] text-[var(--warning)] px-1">
          Search index offline (PG fallback) — results may lag Typesense.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 px-1 text-[11px]">
        <Link href={alertHref} className="text-[var(--accent)] hover:underline">
          Create alert from filters
        </Link>
        <span className="text-[var(--text-muted)]">·</span>
        <span className="text-[var(--text-muted)] font-mono truncate max-w-md">
          {searchParams.q}
        </span>
      </div>
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
          emptyTitle="No spans match"
          emptyDescription="Try widening your query or time range. Use agent: / status: / text: tokens."
          hasMore={total > hits.length}
          onLoadMore={loadMore}
        />
      )}
    </div>
  );
}
