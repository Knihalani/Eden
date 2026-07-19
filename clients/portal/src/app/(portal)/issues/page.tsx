"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useOrg } from "@/hooks/use-org";
import { agentIssuesApi, type AgentIssue } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { EmptyState } from "@/components/ui/empty-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AlertCircle, BookOpen, Key, Loader2, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage, DetailPanelShell, useResourceUrlState, VirtualizedList, ResourceOsToolbar, BulkActionBar } from "@/components/portal-os";
import { CrossLinkBar } from "@/components/portal-os/CrossLinkBar";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import { useQueryTab } from "@/hooks/use-query-tab";
import { usePagePerf, useTableQueryPerf } from "@/lib/perf";
import { artifactHref, experimentHref } from "@/lib/portal-cross-links";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";
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
}: {
  selectedId?: string;
  onSelect: (id: string) => void;
  onIssuesChange?: (issues: AgentIssue[]) => void;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
}) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [limit, setLimit] = useState(PAGE_SIZE);

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
  const loadMore = () => setLimit((l) => Math.min(l + PAGE_SIZE, MAX_LIMIT));

  useEffect(() => {
    onIssuesChange?.(issues);
  }, [issues, onIssuesChange]);

  useTableQueryPerf("/issues", refreshing, loading);

  const exportRows = issues.map((i) => ({
    id: i.id,
    title: i.title,
    status: i.status,
    severity: i.severity,
    stumbles: i.stumble_count,
  }));

  return (
    <>
      <ResourceOsToolbar
        resourceKey="issues"
        onCreateAlert={() => {
          window.location.href = "/alerts?tab=rules";
        }}
        exportRows={exportRows}
        exportFilename="issues.csv"
        className="mb-4"
      />
      <div role="tablist" aria-label="Issue status filter" className="flex items-center gap-1 mb-4 border-b border-[var(--border-default)] overflow-x-auto">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={statusFilter === s}
            onClick={() => {
              setStatusFilter(s);
              setLimit(PAGE_SIZE);
            }}
            className={cn(
              "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap capitalize",
              statusFilter === s
                ? "border-[var(--accent)] text-[var(--text-primary)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]",
            )}
          >
            {s.replace("_", " ")}
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" className="mb-4 flex items-start justify-between gap-2 rounded-lg border border-[var(--error)] bg-[var(--error-bg)] p-3 text-sm text-[var(--error)]">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Failed to load issues</p>
              <p className="text-xs mt-1 opacity-80">{error}</p>
            </div>
          </div>
          <button onClick={load} disabled={loading} className="text-xs font-medium underline underline-offset-2 hover:opacity-80 disabled:opacity-50 shrink-0">
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div role="status" aria-busy="true" className="flex items-center justify-center p-12 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading…
        </div>
      ) : issues.length === 0 ? (
        <EmptyState
          icon={ShieldAlert}
          title="No issues yet"
          description={U20_EMPTY_COPY.issues}
          size="lg"
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button asChild className="min-h-11">
                <a href={DOCS_QUICKSTART_URL} target="_blank" rel="noopener noreferrer">
                  <BookOpen className="h-4 w-4" />
                  Install SDK
                </a>
              </Button>
              <Button asChild variant="outline" className="min-h-11">
                <Link href="/settings?tab=api-keys">
                  <Key className="h-4 w-4" />
                  API keys
                </Link>
              </Button>
            </div>
          }
        />
      ) : (
        <VirtualizedList
          items={issues}
          rowKey={(i) => i.id}
          className="space-y-2"
        >
          {(i) => {
            const checked = selectedIds.includes(i.id);
            return (
              <div
                key={i.id}
                className={cn(
                  "row-select-highlight flex w-full items-start gap-3 rounded-lg border bg-[var(--bg-primary)] p-4 hover:border-[var(--accent)] transition-colors",
                  selectedId === i.id
                    ? "border-[var(--accent)] ring-1 ring-[var(--accent)]/30 is-selected"
                    : "border-[var(--border-default)]",
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
                  <div className="flex items-center gap-2 flex-wrap">
                    <IssueSeverityBadge severity={i.severity} />
                    <StatusBadge status={i.status} />
                    <span className="text-xs font-mono px-2 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                      {i.kind}
                    </span>
                    {i.repetition_count > 1 && <RepeatBadge count={i.repetition_count} />}
                    <RegressionBadge regressionCaseId={i.regression_case_id} status={i.status} />
                  </div>
                  <p className="mt-2 text-sm font-medium text-[var(--text-primary)] truncate">{i.title}</p>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    {i.stumble_count} stumble{i.stumble_count === 1 ? "" : "s"} · {i.user_count} user{i.user_count === 1 ? "" : "s"}
                    {i.agent_id ? ` · ${i.agent_id}` : ""}
                    {i.last_seen ? ` · last seen ${new Date(i.last_seen).toLocaleString()}` : ""}
                  </p>
                </button>
              </div>
            );
          }}
        </VirtualizedList>
      )}

      {canLoadMore && (
        <div className="flex justify-center pt-4">
          <Button variant="outline" size="default" onClick={loadMore} loading={refreshing} disabled={refreshing}>
            Load more issues
          </Button>
        </div>
      )}
    </>
  );
}

function IssuesPageInner() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  usePagePerf("/issues");
  const [tab, setTab] = useQueryTab("tab", TOP_TABS, "issues");
  const { state: urlState, setState: setUrlState } = useResourceUrlState();
  const issueId = urlState.issueId;
  const [listIssues, setListIssues] = useState<AgentIssue[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const toast = useToast();
  const queryClient = useQueryClient();

  const issueDetailQuery = useOrgQuery(
    queryKeys.issues.detail(orgId, issueId),
    orgId,
    () => agentIssuesApi.get(orgId!, issueId!),
    { enabled: Boolean(orgId) && Boolean(issueId) },
  );
  const selectedIssue: AgentIssue | null = issueDetailQuery.data?.data?.issue ?? null;
  const issueIndex = issueId ? listIssues.findIndex((i) => i.id === issueId) : -1;

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
    <CoreResourcePage
      header={
        <PageHeader
          title="Issues"
          subtitle="Grouped agent failures and systemic incident clusters."
          icon={ShieldAlert}
          description="Triage stumbles here; switch to Incidents for RCA clusters across many failures."
        />
      }
      toolbar={
        <div role="tablist" aria-label="Issues sections" className="mb-4 flex gap-1 border-b border-[var(--border-default)]">
          {TOP_TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                "px-3 py-2 text-sm font-medium capitalize border-b-2 -mb-px",
                tab === t
                  ? "border-[var(--accent)] text-[var(--text-primary)]"
                  : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]",
              )}
            >
              {t}
            </button>
          ))}
        </div>
      }
      table={
        tab === "issues" ? (
          <IssuesList
            selectedId={issueId}
            onSelect={(id) => setUrlState({ issueId: id })}
            onIssuesChange={setListIssues}
            selectedIds={selectedIds}
            onSelectedIdsChange={setSelectedIds}
          />
        ) : (
          <EmbeddedSurface>
            <IncidentsView />
          </EmbeddedSurface>
        )
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
              <Button variant="outline" size="sm" asChild>
                <Link href={`/issues/${issueId}`}>Open full page</Link>
              </Button>
            }
          >
            {issueDetailQuery.isLoading ? (
              <div className="flex items-center justify-center p-8 text-sm text-[var(--text-muted)]">
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading…
              </div>
            ) : selectedIssue ? (
              <div className="flex h-full flex-col">
                <CrossLinkBar
                  links={[
                    { label: "Improve plan", href: `/improve?issue=${selectedIssue.id}` },
                    { label: "Run experiment", href: experimentHref(undefined, selectedIssue.id) },
                    { label: "Create artifact", href: artifactHref() },
                    { label: "Export fixture", href: `/issues/${selectedIssue.id}` },
                    ...(selectedIssue.experiment_id
                      ? [{ label: "Linked experiment", href: experimentHref(selectedIssue.experiment_id) }]
                      : []),
                  ]}
                />
                <div className="space-y-4 p-4 text-sm">
                <div className="flex flex-wrap gap-2">
                  <IssueSeverityBadge severity={selectedIssue.severity} />
                  <StatusBadge status={selectedIssue.status} />
                </div>
                <p className="text-[var(--text-secondary)]">
                  {typeof selectedIssue.triage_result?.summary === "string"
                    ? selectedIssue.triage_result.summary
                    : `${selectedIssue.kind} · ${selectedIssue.status}`}
                </p>
                <dl className="grid gap-2 text-xs">
                  <div className="flex justify-between gap-4">
                    <dt className="text-[var(--text-muted)]">Stumbles</dt>
                    <dd>{selectedIssue.stumble_count}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-[var(--text-muted)]">Users</dt>
                    <dd>{selectedIssue.user_count}</dd>
                  </div>
                  {selectedIssue.agent_id ? (
                    <div className="flex justify-between gap-4">
                      <dt className="text-[var(--text-muted)]">Agent</dt>
                      <dd className="font-mono truncate">{selectedIssue.agent_id}</dd>
                    </div>
                  ) : null}
                </dl>
                <div className="flex flex-wrap gap-2 pt-2">
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
