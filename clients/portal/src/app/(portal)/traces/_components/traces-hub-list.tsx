"use client";

/**
 * Hub list surface — empty / error / Spans / Sessions / Live rail.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpen, Key, Layers } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import { WaitingForFirstEvent } from "@/components/onboarding/WaitingForFirstEvent";
import { TracesTab } from "../../observability/_components/TracesTab";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { U20_FILTER_EMPTY_COPY } from "@/lib/portal-polish";
import { promoteTracesToDatasetHref } from "@/lib/portal-cross-links";
import { LiveTailPanel, SpansTab, SessionsTab } from "./traces-hub-dynamics";
import { isTracesUnreviewedSoftView } from "./trace-builtin-views";
import type { TracesHubState } from "./use-traces-hub";
import type { TraceItem } from "../../observability/_lib/types";

type ListProps = Pick<
  TracesHubState,
  | "hubView"
  | "liveOn"
  | "orgId"
  | "currentOrg"
  | "canManageKeys"
  | "showError"
  | "showFirstRunEmpty"
  | "showFilteredEmpty"
  | "errorMessage"
  | "refresh"
  | "refreshing"
  | "firstTraceAt"
  | "traces"
  | "tracesTotal"
  | "loading"
  | "loadingMore"
  | "effectiveFilter"
  | "handleSelectTrace"
  | "handleViewTimeline"
  | "handleViewTree"
  | "handleExport"
  | "handleAnnotate"
  | "traceId"
  | "visibleColumns"
  | "tableSort"
  | "setTableSort"
  | "setOffset"
  | "PAGE_SIZE"
  | "query"
  | "applyListFilters"
  | "applyView"
  | "setQuery"
  | "savedViewId"
  | "pastHours"
>;

export function TracesHubList(hub: ListProps) {
  const router = useRouter();
  const {
    hubView,
    liveOn,
    orgId,
    currentOrg,
    canManageKeys,
    showError,
    showFirstRunEmpty,
    showFilteredEmpty,
    errorMessage,
    refresh,
    refreshing,
    firstTraceAt,
    traces,
    tracesTotal,
    loading,
    loadingMore,
    effectiveFilter,
    handleSelectTrace,
    handleViewTimeline,
    handleViewTree,
    handleExport,
    handleAnnotate,
    traceId,
    visibleColumns,
    tableSort,
    setTableSort,
    setOffset,
    PAGE_SIZE,
    query,
    applyListFilters,
    applyView,
    setQuery,
    savedViewId,
    pastHours,
  } = hub;

  return (
    <>
      {hubView === "traces" && (
        <div
          className={
            liveOn ? "grid gap-4 lg:grid-cols-[1fr_18rem]" : "space-y-4"
          }
        >
          <div className="space-y-4 min-w-0">
            {isTracesUnreviewedSoftView(savedViewId) ? (
              <p
                className="text-xs text-[var(--warning)]"
                data-testid="traces-unreviewed-soft-note"
                role="status"
              >
                Unreviewed is a soft view — unscored/reviewed filters are not on
                list rows yet, so all traces in range are shown.
              </p>
            ) : null}
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
                          <a
                            href={DOCS_QUICKSTART_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <BookOpen className="h-4 w-4" />
                            Docs quickstart
                          </a>
                        </Button>
                      )}
                      {canManageKeys ? (
                        <Button asChild variant="ghost" className="min-h-11">
                          <a
                            href={DOCS_QUICKSTART_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
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
              <TracesTab
                traces={traces}
                loading={loading}
                filter={effectiveFilter}
                onSelectTrace={handleSelectTrace}
                onViewTimeline={handleViewTimeline}
                onViewTree={handleViewTree}
                onExport={handleExport}
                onAnnotate={handleAnnotate}
                initialTraceId={traceId || undefined}
                hasMore={!loading && !showError && tracesTotal > traces.length}
                onLoadMore={() => setOffset((o) => o + PAGE_SIZE)}
                loadingMore={loadingMore}
                visibleColumns={visibleColumns}
                defaultSort={tableSort ?? undefined}
                onSortChange={setTableSort}
                selectable
                bulkActions={[
                  {
                    label: "Add to dataset",
                    onClick: (rows: TraceItem[]) => {
                      const ids = rows.map((r) => r.trace_id).filter(Boolean);
                      if (ids.length === 0) return;
                      router.push(
                        promoteTracesToDatasetHref(ids, {
                          ...(query ? { q: query } : {}),
                          ...(pastHours && pastHours !== "168"
                            ? { pastHours }
                            : {}),
                          ...(effectiveFilter.outcome
                            ? { outcome: effectiveFilter.outcome }
                            : {}),
                          ...(effectiveFilter.agent_id
                            ? { agent_id: effectiveFilter.agent_id }
                            : {}),
                          ...(effectiveFilter.realm
                            ? { realm: effectiveFilter.realm }
                            : {}),
                        }),
                      );
                    },
                  },
                ]}
              />
            )}
          </div>
          {liveOn && currentOrg ? (
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
          selectedTraceId={traceId || undefined}
          onSelectTrace={handleSelectTrace}
          preserve={{
            ...(query ? { q: query } : {}),
            ...(pastHours && pastHours !== "168" ? { pastHours } : {}),
            ...(effectiveFilter.outcome ? { outcome: effectiveFilter.outcome } : {}),
            ...(effectiveFilter.agent_id ? { agent_id: effectiveFilter.agent_id } : {}),
            ...(effectiveFilter.realm ? { realm: effectiveFilter.realm } : {}),
            view: "sessions",
          }}
        />
      )}
    </>
  );
}
