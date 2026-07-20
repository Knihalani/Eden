"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { agentIssuesApi, ApiError, type AgentIssue } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { QueryState } from "@/components/ui/query-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { BookOpen, ChevronDown, Key, Loader2, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage, DetailPanelShell, useResourceUrlState, VirtualizedList, ResourceOsToolbar, BulkActionBar } from "@/components/portal-os";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useQueryTab } from "@/hooks/use-query-tab";
import { usePagePerf, useTableQueryPerf } from "@/lib/perf";
import { artifactHref, experimentHref } from "@/lib/portal-cross-links";
import { U20_EMPTY_COPY, U20_FILTER_EMPTY_COPY } from "@/lib/portal-polish";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { useToast } from "@/components/ui/toast";
import { RepeatBadge, RegressionBadge, IssueSeverityBadge, StatusBadge } from "./_components/issue-badges";
import { useQueryClient } from "@tanstack/react-query";

const STATUS_FILTERS = [
  "all",
  "open",
  "triaged",
  "fix_pending",
  "verifying",
  "resolved",
  "regressed",
] as const;

const PAGE_SIZE = 100;
const MAX_LIMIT = 200;
const TOP_TABS = ["issues", "incidents"] as const;
const TOP_TAB_LABELS: Record<(typeof TOP_TABS)[number], string> = {
  issues: "Agent Issues",
  incidents: "Incidents",
};

const IncidentsView = dynamic(() => import("@/app/(portal)/incidents/page"), {
  ssr: false,
  loading: () => (
    <div className="flex h-48 items-center justify-center">
      <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
    </div>
  ),
});

function IssuesList({
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
  // API key create/revoke is owner/admin only (settings:edit). Members
  // and viewers must not get a primary "API keys" first-run CTA.
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
    <div className="flex flex-col gap-space-4">
      <QueryState
        loading={loading}
        error={issuesQuery.error}
        data={issuesQuery.data}
        onRetry={load}
        errorTitle="Could not load issues"
        isEmpty={(d) => (d?.data?.issues.length ?? 0) === 0}
        loadingSlot={<LoadingSkeleton variant="table" lines={5} className="p-0 max-w-none" />}
        emptySlot={
          <EmptyState
            icon={ShieldAlert}
            title={statusFiltered ? "No matching issues" : "No issues yet"}
            description={
              statusFiltered
                ? U20_FILTER_EMPTY_COPY.issues
                : U20_EMPTY_COPY.issues
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
                    <span className="text-xs text-[var(--text-muted)] px-space-3 py-space-2">
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
                        ? "bg-[var(--accent-faint)]/40 ring-1 ring-[var(--accent)]/30 is-selected"
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
                      <div className="flex items-center gap-space-2 flex-wrap">
                        <IssueSeverityBadge severity={i.severity} />
                        <StatusBadge status={i.status} />
                        <span className="text-xs font-mono px-space-2 py-space-1 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                          {i.kind}
                        </span>
                        {i.repetition_count > 1 && <RepeatBadge count={i.repetition_count} />}
                        <RegressionBadge regressionCaseId={i.regression_case_id} status={i.status} />
                      </div>
                      <p className="mt-space-2 text-sm font-medium text-[var(--text-primary)] truncate">{i.title}</p>
                      <p className="mt-space-1 text-xs text-[var(--text-muted)]">
                        {i.stumble_count} stumble{i.stumble_count === 1 ? "" : "s"} · {i.user_count} user{i.user_count === 1 ? "" : "s"}
                        {i.agent_id ? ` · ${i.agent_id}` : ""}
                        {i.last_seen ? ` · last seen ${new Date(i.last_seen).toLocaleString()}` : ""}
                      </p>
                    </button>
                  </div>
                );
              }}
            </VirtualizedList>

            {canLoadMore && (
              <div className="flex justify-center pt-space-4">
                <Button variant="outline" size="default" onClick={loadMore} loading={refreshing} disabled={refreshing}>
                  Load more issues
                </Button>
              </div>
            )}
          </>
        )}
      </QueryState>
    </div>
  );
}

function IssuesPageInner() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const router = useRouter();
  usePagePerf("/issues");
  const [tab, setTab] = useQueryTab("tab", TOP_TABS, "issues");
  const { state: urlState, setState: setUrlState } = useResourceUrlState();
  const issueId = urlState.issueId;
  const [listIssues, setListIssues] = useState<AgentIssue[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const toast = useToast();
  const queryClient = useQueryClient();

  const issueDetailQuery = useOrgQuery(
    queryKeys.issues.detail(orgId, issueId),
    orgId,
    () => agentIssuesApi.get(orgId!, issueId!),
    { enabled: Boolean(orgId) && Boolean(issueId) },
  );
  const selectedIssue: AgentIssue | null = issueDetailQuery.data?.data?.issue ?? null;
  const issueDetailNotFound =
    issueDetailQuery.error instanceof ApiError && issueDetailQuery.error.status === 404;
  const issueDetailError = issueDetailQuery.error?.message ?? null;
  const issueIndex = issueId ? listIssues.findIndex((i) => i.id === issueId) : -1;

  const exportRows = listIssues.map((i) => ({
    id: i.id,
    title: i.title,
    status: i.status,
    severity: i.severity,
    stumbles: i.stumble_count,
  }));

  if (!currentOrg) {
    return (
      <NoOrgState
        feature="Issues"
        icon={ShieldAlert}
        description="Select an organization to review grouped agent failures"
      />
    );
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as (typeof TOP_TABS)[number])}
    >
    <CoreResourcePage
      header={
        <PageHeader
          title="Agent Issues"
          subtitle={
            tab === "incidents"
              ? "Incidents nest here — systemic RCA clusters across many traces (not a separate sidebar leaf)."
              : "Grouped agent failures — the primary triage loop. Switch to Incidents for systemic RCA clusters."
          }
          description="Triage stumbles here; Incidents cluster many failures into one RCA summary. /incidents redirects into this hub."
        />
      }
      toolbar={
        <div
          className="flex flex-col gap-space-3"
          data-testid="issues-toolbar"
        >
          <TabsList
            variant="underline"
            aria-label="Issues sections"
            className="h-auto w-full justify-start gap-space-1 bg-transparent"
          >
            {TOP_TABS.map((t) => (
              <TabsTrigger
                key={t}
                variant="underline"
                value={t}
                title={TOP_TAB_LABELS[t]}
                className="min-h-11"
              >
                {TOP_TAB_LABELS[t]}
              </TabsTrigger>
            ))}
          </TabsList>
          {tab === "issues" ? (
            <ResourceOsToolbar
              resourceKey="issues"
              sticky
              onCreateAlert={() => {
                router.push("/alerts?tab=rules");
              }}
              exportRows={exportRows}
              exportFilename="issues.csv"
              selects={[
                {
                  key: "status",
                  label: "Status",
                  value: statusFilter === "all" ? "" : statusFilter,
                  options: STATUS_FILTERS.filter((s) => s !== "all").map((s) => ({
                    value: s,
                    label: s.replace("_", " "),
                  })),
                },
              ]}
              onFiltersChange={(next) => {
                const status = next.status?.trim();
                setStatusFilter(status ? status : "all");
                setLimit(PAGE_SIZE);
              }}
            />
          ) : null}
        </div>
      }
      table={
        <>
        <TabsContent value="issues" className="mt-0">
          <IssuesList
            selectedId={issueId}
            onSelect={(id) => setUrlState({ issueId: id })}
            onIssuesChange={setListIssues}
            selectedIds={selectedIds}
            onSelectedIdsChange={setSelectedIds}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            limit={limit}
            onLimitChange={setLimit}
          />
        </TabsContent>
        <TabsContent value="incidents" className="mt-0">
          <EmbeddedSurface>
            <IncidentsView />
          </EmbeddedSurface>
        </TabsContent>
        </>
      }
      bulkBar={
        <BulkActionBar
          count={selectedIds.length}
          onClear={() => setSelectedIds([])}
          actions={[
            {
              label: bulkBusy ? "Triaging…" : "Mark triaged",
              onClick: () => {
                if (!orgId || selectedIds.length === 0 || bulkBusy) return;
                setBulkBusy(true);
                void Promise.allSettled(
                  selectedIds.map((id) => agentIssuesApi.triage(orgId, id, { force: false })),
                )
                  .then((results) => {
                    const ok = results.filter((r) => r.status === "fulfilled").length;
                    toast.success(`Triaged ${ok}/${selectedIds.length} issues`);
                    setSelectedIds([]);
                    void queryClient.invalidateQueries({ queryKey: queryKeys.issues.all });
                  })
                  .finally(() => setBulkBusy(false));
              },
            },
            {
              label: bulkBusy ? "Resolving…" : "Resolve",
              variant: "destructive",
              onClick: () => {
                if (!orgId || selectedIds.length === 0 || bulkBusy) return;
                setBulkBusy(true);
                void Promise.allSettled(
                  selectedIds.map((id) =>
                    agentIssuesApi.resolve(orgId, id, { status: "resolved" }),
                  ),
                )
                  .then((results) => {
                    const ok = results.filter((r) => r.status === "fulfilled").length;
                    toast.success(`Resolved ${ok}/${selectedIds.length} issues`);
                    setSelectedIds([]);
                    void queryClient.invalidateQueries({ queryKey: queryKeys.issues.all });
                  })
                  .finally(() => setBulkBusy(false));
              },
            },
          ]}
        />
      }
      detail={
        issueId ? (
          <DetailPanelShell
            open
            onClose={() => setUrlState({ issueId: undefined })}
            title={selectedIssue?.title ?? "Issue"}
            onPrev={
              issueIndex > 0
                ? () => setUrlState({ issueId: listIssues[issueIndex - 1]?.id })
                : undefined
            }
            onNext={
              issueIndex >= 0 && issueIndex < listIssues.length - 1
                ? () => setUrlState({ issueId: listIssues[issueIndex + 1]?.id })
                : undefined
            }
            headerActions={
              <div className="flex flex-wrap items-center gap-space-2">
                {selectedIssue ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="min-h-11" aria-label="Related surfaces">
                        Go to
                        <ChevronDown className="h-4 w-4" aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[12rem]">
                      <DropdownMenuLabel>Go to</DropdownMenuLabel>
                      <DropdownMenuItem asChild>
                        <Link href={`/improve?issue=${selectedIssue.id}`}>Improve plan</Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href={experimentHref(undefined, selectedIssue.id)}>Run experiment</Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href={artifactHref()}>Create artifact</Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href={`/issues/${selectedIssue.id}`}>Export fixture</Link>
                      </DropdownMenuItem>
                      {selectedIssue.experiment_id ? (
                        <DropdownMenuItem asChild>
                          <Link href={experimentHref(selectedIssue.experiment_id)}>
                            Linked experiment
                          </Link>
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
                <Button variant="outline" size="sm" asChild className="min-h-11">
                  <Link href={`/issues/${issueId}`}>Open full page</Link>
                </Button>
              </div>
            }
          >
            {issueDetailQuery.isLoading ? (
              <div className="flex items-center justify-center p-8 text-sm text-[var(--text-muted)]">
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading…
              </div>
            ) : issueDetailNotFound || (!selectedIssue && !issueDetailError) ? (
              <p className="p-4 text-sm text-[var(--text-muted)]">Issue not found.</p>
            ) : issueDetailError ? (
              <ErrorState
                title="Could not load issue"
                message={issueDetailError}
                size="sm"
                className="m-4"
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    onClick={() => void issueDetailQuery.refetch()}
                  >
                    Try again
                  </Button>
                }
              />
            ) : selectedIssue ? (
              <div className="flex h-full flex-col">
                <div className="space-y-space-4 p-space-4 text-sm">
                <div className="flex flex-wrap gap-space-2">
                  <IssueSeverityBadge severity={selectedIssue.severity} />
                  <StatusBadge status={selectedIssue.status} />
                </div>
                <p className="text-[var(--text-secondary)]">
                  {typeof selectedIssue.triage_result?.summary === "string"
                    ? selectedIssue.triage_result.summary
                    : `${selectedIssue.kind} · ${selectedIssue.status}`}
                </p>
                <dl className="grid gap-space-2 text-xs">
                  <div className="flex justify-between gap-space-4">
                    <dt className="text-[var(--text-muted)]">Stumbles</dt>
                    <dd>{selectedIssue.stumble_count}</dd>
                  </div>
                  <div className="flex justify-between gap-space-4">
                    <dt className="text-[var(--text-muted)]">Users</dt>
                    <dd>{selectedIssue.user_count}</dd>
                  </div>
                  {selectedIssue.agent_id ? (
                    <div className="flex justify-between gap-space-4">
                      <dt className="text-[var(--text-muted)]">Agent</dt>
                      <dd className="font-mono truncate">{selectedIssue.agent_id}</dd>
                    </div>
                  ) : null}
                </dl>
                <div className="flex flex-wrap gap-space-2 pt-space-2">
                  <Button
                    size="sm"
                    variant="default"
                    disabled={bulkBusy}
                    onClick={() => {
                      if (!orgId) return;
                      setBulkBusy(true);
                      void agentIssuesApi
                        .triage(orgId, selectedIssue.id)
                        .then(() => {
                          toast.success("Triage started");
                          void issueDetailQuery.refetch();
                        })
                        .catch((e: unknown) =>
                          toast.error(e instanceof Error ? e.message : "Triage failed"),
                        )
                        .finally(() => setBulkBusy(false));
                    }}
                  >
                    Re-triage
                  </Button>
                  <Button size="sm" variant="secondary" asChild>
                    <Link href={`/improve?issue=${selectedIssue.id}`}>View improvement plan</Link>
                  </Button>
                  <Button size="sm" variant="outline" asChild>
                    <Link href={`/issues/${selectedIssue.id}`}>Open full · export fixture</Link>
                  </Button>
                </div>
                </div>
              </div>
            ) : (
              <p className="p-4 text-sm text-[var(--text-muted)]">Issue not found.</p>
            )}
          </DetailPanelShell>
        ) : null
      }
    />
    </Tabs>
  );
}

export default function IssuesPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
        </div>
      }
    >
      <IssuesPageInner />
    </Suspense>
  );
}
