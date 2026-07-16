"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import dynamic from "next/dynamic";
import { useOrg } from "@/hooks/use-org";
import { agentIssuesApi } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { EmptyState } from "@/components/ui/empty-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AlertCircle, Loader2, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import { useQueryTab } from "@/hooks/use-query-tab";
import { RepeatBadge, RegressionBadge, SeverityBadge, StatusBadge } from "./_components/issue-badges";

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

const IncidentsView = dynamic(() => import("../incidents/page"), {
  ssr: false,
  loading: () => (
    <div className="flex h-48 items-center justify-center">
      <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
    </div>
  ),
});

function IssuesList() {
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

  return (
    <>
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
        <Card padding="lg">
          <EmptyState
            icon={ShieldAlert}
            title="No issues yet"
            description="Issues appear automatically when Eden detects agent failures in finalized traces — usually within 60 seconds of a failed run."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Link href="/dashboard?onboarding=1">
                  <Button>
                    <ShieldAlert className="h-4 w-4" />
                    Install SDK
                  </Button>
                </Link>
                <Link href="/issues?tab=incidents">
                  <Button variant="outline">View Incidents</Button>
                </Link>
              </div>
            }
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {issues.map((i) => (
            <Link
              key={i.id}
              href={`/issues/${i.id}`}
              className="block rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4 hover:border-[var(--accent)] transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <SeverityBadge severity={i.severity} />
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
                </div>
              </div>
            </Link>
          ))}
        </div>
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
  const [tab, setTab] = useQueryTab("tab", TOP_TABS, "issues");

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
    <PageContent size="default">
      <PageHeader
        title="Issues"
        subtitle="Grouped agent failures and systemic incident clusters."
        icon={ShieldAlert}
        description="Triage stumbles here; switch to Incidents for RCA clusters across many failures."
      />

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

      {tab === "issues" ? (
        <IssuesList />
      ) : (
        <EmbeddedSurface>
          <IncidentsView />
        </EmbeddedSurface>
      )}
    </PageContent>
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
