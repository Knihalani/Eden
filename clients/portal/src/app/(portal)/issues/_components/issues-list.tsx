"use client";

import Link from "next/link";
import type { AgentIssue } from "@/lib/api";
import { agentIssuesApi } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryState } from "@/components/ui/query-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { VirtualizedList } from "@/components/portal-os";
import { cn } from "@/lib/utils";
import { BookOpen, Key, ShieldAlert } from "lucide-react";
import { useEffect } from "react";
import { useTableQueryPerf } from "@/lib/perf";
import { U20_EMPTY_COPY, U20_FILTER_EMPTY_COPY } from "@/lib/portal-polish";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import {
  RepeatBadge,
  RegressionBadge,
  IssueSeverityBadge,
  StatusBadge,
} from "./issue-badges";

const PAGE_SIZE = 100;
const MAX_LIMIT = 200;

export { PAGE_SIZE, MAX_LIMIT };

export function IssuesList({
  selectedId,
  onSelect,
  onIssuesChange,
  selectedIds,
  onSelectedIdsChange,
  statusFilter,
  onStatusFilterChange,
  limit,
  onLimitChange,
}: {
  selectedId?: string;
  onSelect: (id: string) => void;
  onIssuesChange?: (issues: AgentIssue[]) => void;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
  statusFilter: string;
  onStatusFilterChange: (status: string) => void;
  limit: number;
  onLimitChange: (limit: number) => void;
}) {
  const { currentOrg } = useOrg();
  const { hasPermission } = usePermissions();
  const canManageKeys = hasPermission("settings:edit");
  const orgId = currentOrg?.id ?? null;

  const issuesFilter = { status: statusFilter === "all" ? undefined : statusFilter, limit };
  const issuesQuery = useOrgQuery(
    queryKeys.issues.list(orgId, issuesFilter),
    orgId,
    () => agentIssuesApi.list(orgId!, issuesFilter),
  );
  const issues = issuesQuery.data?.data?.issues ?? [];
  const loading = issuesQuery.isLoading;
  const refreshing = issuesQuery.isFetching;
  const error = issuesQuery.error?.message ?? null;
  const load = () => void issuesQuery.refetch();
  const canLoadMore = !loading && !error && limit < MAX_LIMIT && issues.length === limit;
  const loadMore = () => onLimitChange(Math.min(limit + PAGE_SIZE, MAX_LIMIT));

  useEffect(() => {
    onIssuesChange?.(issues);
  }, [issues, onIssuesChange]);

  useTableQueryPerf("/issues", refreshing, loading);

  const statusFiltered = statusFilter !== "all";

  return (
    <div className="flex flex-col gap-space-4" data-wave11-mobile="cards">
      <QueryState
        loading={loading}
        error={issuesQuery.error}
        data={issuesQuery.data}
        onRetry={load}
        errorTitle="Could not load issues"
        isEmpty={(d) => (d?.data?.issues.length ?? 0) === 0}
        loadingSlot={<LoadingSkeleton variant="table" lines={5} className="max-w-none p-0" />}
        emptySlot={
          <EmptyState
            icon={ShieldAlert}
            title={statusFiltered ? "No matching issues" : "No issues yet"}
            description={
              statusFiltered ? U20_FILTER_EMPTY_COPY.issues : U20_EMPTY_COPY.issues
            }
            size="lg"
            action={
              statusFiltered ? (
                <Button
                  variant="link"
                  className="min-h-11 px-0"
                  onClick={() => {
                    onStatusFilterChange("all");
                    onLimitChange(PAGE_SIZE);
                  }}
                >
                  Clear status filter
                </Button>
              ) : (
                <div className="flex flex-wrap items-center justify-center gap-space-2">
                  <Button asChild className="min-h-11">
                    <a href={DOCS_QUICKSTART_URL} target="_blank" rel="noopener noreferrer">
                      <BookOpen className="h-4 w-4" />
                      Install SDK
                    </a>
                  </Button>
                  {canManageKeys ? (
                    <Button asChild variant="outline" className="min-h-11">
                      <Link href="/settings?tab=api-keys">
                        <Key className="h-4 w-4" />
                        API keys
                      </Link>
                    </Button>
                  ) : (
                    <span className="px-space-3 py-space-2 text-xs text-[var(--text-muted)]">
                      Ask an admin for an API key
                    </span>
                  )}
                </div>
              )
            }
          />
        }
      >
        {() => (
          <>
            <VirtualizedList
              items={issues}
              rowKey={(i) => i.id}
              className="divide-y divide-[var(--border-subtle)]"
            >
              {(i) => {
                const checked = selectedIds.includes(i.id);
                return (
                  <div
                    key={i.id}
                    className={cn(
                      "row-select-highlight flex w-full items-start gap-space-3 rounded-lg px-space-3 py-space-3 transition-colors hover:bg-[var(--bg-secondary)]",
                      selectedId === i.id
                        ? "is-selected bg-[var(--accent-faint)]/40 ring-1 ring-[var(--accent)]/30"
                        : "",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0"
                      checked={checked}
                      aria-label={`Select ${i.title}`}
                      onChange={(e) => {
                        if (e.target.checked) onSelectedIdsChange([...selectedIds, i.id]);
                        else onSelectedIdsChange(selectedIds.filter((id) => id !== i.id));
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => onSelect(i.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex flex-wrap items-center gap-space-2">
                        <IssueSeverityBadge severity={i.severity} />
                        <StatusBadge status={i.status} />
                        <span className="rounded bg-[var(--bg-tertiary)] px-space-2 py-space-1 font-mono text-xs text-[var(--text-muted)]">
                          {i.kind}
                        </span>
                        {i.repetition_count > 1 ? <RepeatBadge count={i.repetition_count} /> : null}
                        <RegressionBadge
                          regressionCaseId={i.regression_case_id}
                          status={i.status}
                        />
                      </div>
                      <p className="mt-space-2 truncate text-sm font-medium text-[var(--text-primary)]">
                        {i.title}
                      </p>
                      <p className="mt-space-1 text-xs text-[var(--text-muted)]">
                        {i.stumble_count} stumble{i.stumble_count === 1 ? "" : "s"} · {i.user_count}{" "}
                        user{i.user_count === 1 ? "" : "s"}
                        {i.agent_id ? ` · ${i.agent_id}` : ""}
                        {i.last_seen
                          ? ` · last seen ${new Date(i.last_seen).toLocaleString()}`
                          : ""}
                      </p>
                    </button>
                  </div>
                );
              }}
            </VirtualizedList>

            {canLoadMore ? (
              <div className="flex justify-center pt-space-4">
                <Button
                  variant="outline"
                  size="default"
                  onClick={loadMore}
                  loading={refreshing}
                  disabled={refreshing}
                >
                  Load more issues
                </Button>
              </div>
            ) : null}
          </>
        )}
      </QueryState>
    </div>
  );
}
