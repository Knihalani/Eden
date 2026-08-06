"use client";

import Link from "next/link";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "next/navigation";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { ChevronLeft, X } from "lucide-react";
import {
  agentForIssue,
  occurrencesForIssue,
  type IssueFixture,
  type IssueStatus,
} from "@/lab/fixtures/issues";
import {
  formatDuration,
  formatTokens,
  formatUsd,
} from "@/lab/fixtures/traces";
import { PageHeader, StatusChip } from "@/components/ds/primitives";
import { SavedViewsMenu } from "@/components/portal/saved-views-menu";
import {
  agentScopeCounts,
  useAgentScope,
  useQueryPatch,
} from "@/lab/agent-scope";
import {
  AgentLink,
  AgentScopeFilter,
  EmptyState,
  FilterChips,
  SeverityBadge,
} from "@/lab/lab-ui";
import { cn } from "@/lib/utils";
import { useOrg } from "@/hooks/use-org";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { agentIssuesApi } from "@/lib/api/resources";
import { SHELL_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { useLabToast } from "@/lab/lab-toast";
import { U20_EMPTY_COPY, U20_FILTER_EMPTY_COPY } from "@/lib/portal-polish";
import { measureVirtualRow, VIRTUAL_SCROLL_ATTR } from "@/lab/virtual-list";

type SeverityFilter = "all" | "error" | "warn";
type DetailTab = "overview" | "runs" | "fix";

/** Deep-linkable via ``?tab=``; anything else falls back to overview. */
const DETAIL_TABS: readonly DetailTab[] = ["overview", "runs", "fix"] as const;

const COLUMNS: { id: IssueStatus; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "acknowledged", label: "In progress" },
  { id: "resolved", label: "Resolved" },
];

/**
 * OPT-9: the issue list is one shared `overflow-y-auto` region with
 * status sections stacked inside it (not side-by-side kanban columns),
 * so it virtualises the same way the traces feed does — flatten
 * section headers + rows into a single index space and use the
 * range extractor to keep the active section header sticky.
 */
type IssueBoardRow =
  | { kind: "header"; key: string; column: IssueStatus; label: string; count: number }
  | { kind: "issue"; key: string; issue: IssueFixture };

/** `.lab-run-row`-shaped card at current density; corrected by `measureElement`. */
const ISSUE_ROW_ESTIMATE = 86;
const ISSUE_HEADER_ESTIMATE = 41;
/** OPT-15: issues page size — matches the API's `limit` default. */
const ISSUES_PAGE_SIZE = 50;

function statusTone(status: IssueStatus): "fail" | "neutral" | "ok" {
  if (status === "open") return "fail";
  if (status === "acknowledged") return "neutral";
  // "resolved" and "ignored" (the latter never reaches the client —
  // see IssueStatus) both read as done.
  return "ok";
}

function IssueStatusChip({ status }: { status: IssueStatus }) {
  const label =
    status === "acknowledged"
      ? "in progress"
      : status === "resolved"
        ? "resolved"
        : status === "ignored"
          ? "dismissed"
          : "open";
  return <StatusChip tone={statusTone(status)}>{label}</StatusChip>;
}

function IssueRow({
  issue,
  active,
  onSelect,
}: {
  issue: IssueFixture;
  active: boolean;
  onSelect: () => void;
}) {
  const agent = agentForIssue(issue);
  return (
    <button
      type="button"
      onClick={onSelect}
      data-issue-id={issue.id}
      data-active={active ? "true" : "false"}
      className={cn(
        "flex w-full items-start gap-3 border-b border-[var(--line)] px-4 py-3 text-left transition-colors sm:px-5",
        active
          ? "bg-[var(--accent-muted)] shadow-[inset_2px_0_0_var(--accent)]"
          : "hover:bg-[var(--accent-muted)]",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={issue.severity} />
          <IssueStatusChip status={issue.status} />
          <span className="type-value tabular-nums !text-[0.625rem] text-[var(--text-muted)]">
            {issue.occurrenceTraceIds.length}×
          </span>
        </div>
        <p className="type-ui truncate text-[var(--text)]">{issue.title}</p>
        <p className="type-meta truncate">
          {agent?.name ?? "unknown"} · {issue.lastSeen}
        </p>
      </div>
    </button>
  );
}

function IssueDetail({
  issue,
  onStatus,
  onDismiss,
  onClose,
  hrefFor,
}: {
  issue: IssueFixture;
  onStatus: (status: IssueStatus) => void;
  onDismiss: () => void;
  onClose: () => void;
  hrefFor: (base: string, extra?: Record<string, string | undefined>) => string;
}) {
  const agent = agentForIssue(issue);
  const runs = occurrencesForIssue(issue);
  // ``?tab=`` makes the detail tabs deep-linkable. The retired
  // ``/issues/:id/fix`` page redirects here with ``tab=fix``; without
  // this the redirect would land on Overview and silently drop intent.
  const searchParams = useSearchParams();
  const patchQuery = useQueryPatch();
  const paramTab = searchParams.get("tab");
  const initialTab: DetailTab = DETAIL_TABS.includes(paramTab as DetailTab)
    ? (paramTab as DetailTab)
    : "overview";
  const [tab, setTab] = useState<DetailTab>(initialTab);

  useEffect(() => {
    setTab(initialTab);
  }, [issue.id, initialTab]);

  const selectTab = useCallback(
    (next: DetailTab) => {
      setTab(next);
      // Overview is the default — drop ``tab`` so the URL stays clean.
      patchQuery({ tab: next === "overview" ? null : next });
    },
    [patchQuery],
  );

  return (
    <aside
      className="flex w-full min-w-0 shrink-0 flex-col overflow-hidden border-[var(--line)] bg-[var(--bg)] lg:max-w-xl lg:border-l"
      aria-label="Issue detail"
    >
      <header className="shrink-0 border-b border-[var(--line)] px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-icon lg:hidden"
                onClick={onClose}
                aria-label="Back to issues"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <SeverityBadge severity={issue.severity} />
              <IssueStatusChip status={issue.status} />
            </div>
            <h2 className="type-title text-[var(--text)] !text-[1.125rem] !leading-snug">
              {issue.title}
            </h2>
            <p className="type-body text-[var(--text-secondary)]">{issue.summary}</p>
            <p className="type-meta">
              <AgentLink agentId={agent?.id} name={agent?.name ?? "unknown"} />
              <span className="text-[var(--text-faint)]"> · </span>
              {issue.lastSeen}
            </p>
          </div>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-icon hidden lg:inline-flex"
            onClick={onClose}
            aria-label="Close detail"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href={`/agent?thread=thr_empty&issueId=${issue.id}&agent=${issue.agentId}${
              runs[0] ? `&traceId=${runs[0].id}` : ""
            }`}
            className="ds-btn ds-btn-outline ds-btn-sm"
          >
            Ask AI
          </Link>
          {issue.status === "open" ? (
            <>
              <button
                type="button"
                className="ds-btn ds-btn-primary ds-btn-sm"
                onClick={() => onStatus("acknowledged")}
              >
                In progress
              </button>
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-sm"
                onClick={() => onStatus("resolved")}
              >
                Confirm
              </button>
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-sm"
                onClick={onDismiss}
              >
                Dismiss
              </button>
            </>
          ) : null}
          {issue.status === "acknowledged" ? (
            <>
              <button
                type="button"
                className="ds-btn ds-btn-primary ds-btn-sm"
                onClick={() => onStatus("resolved")}
              >
                Confirm
              </button>
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-sm"
                onClick={onDismiss}
              >
                Dismiss
              </button>
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-sm"
                onClick={() => onStatus("open")}
              >
                Reopen
              </button>
            </>
          ) : null}
          {issue.status === "resolved" ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              onClick={() => onStatus("open")}
            >
              Reopen
            </button>
          ) : null}
          <Link
            href={`/evals?mode=datasets&from=${issue.id}&agent=${issue.agentId}`}
            className="ds-btn ds-btn-ghost ds-btn-sm"
          >
            Dataset
          </Link>
          {issue.relatedSignalId ? (
            <Link
              href={`/signals?id=${issue.relatedSignalId}`}
              className="ds-btn ds-btn-ghost ds-btn-sm"
            >
              Signal
            </Link>
          ) : null}
        </div>
      </header>

      <dl className="lab-metric-strip shrink-0">
        {[
          { label: "Occurrences", value: String(issue.occurrenceTraceIds.length) },
          { label: "Signals", value: String(issue.signalCount) },
          { label: "First seen", value: issue.firstSeen },
          { label: "Last seen", value: issue.lastSeen },
        ].map((row) => (
          <div key={row.label}>
            <p className="type-label">{row.label}</p>
            <p className="type-mono mt-1.5 truncate !text-[var(--text)]">{row.value}</p>
          </div>
        ))}
      </dl>

      <div
        className="flex shrink-0 gap-1 border-b border-[var(--line)] px-4 py-2 sm:px-5"
        role="tablist"
        aria-label="Issue detail"
      >
        {(
          [
            { id: "overview", label: "Overview" },
            { id: "runs", label: "Runs", count: runs.length },
            { id: "fix", label: "Fix" },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className="ds-tab"
            onClick={() => selectTab(t.id)}
          >
            {t.label}
            {"count" in t && t.count != null ? (
              <span className="ml-1.5 type-value tabular-nums !text-[0.625rem] opacity-80">
                {t.count}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "overview" ? (
          <div className="space-y-8 px-5 py-6 sm:px-6">
            <section className="space-y-3">
              <p className="type-body text-[var(--text-secondary)]">{issue.body}</p>
              {issue.impact ? (
                <p className="type-body text-[var(--text-secondary)]">{issue.impact}</p>
              ) : null}
            </section>
            <section className="space-y-3">
              <h3 className="type-ui text-[var(--text)]">Evidence</h3>
              <pre className="type-mono overflow-x-auto rounded-[var(--radius)] bg-[var(--bg-inset)] px-4 py-3.5 !text-[0.75rem] !leading-relaxed !text-[var(--error)]">
                {issue.errorSample}
              </pre>
              <dl className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <div>
                  <p className="type-label">Detector</p>
                  <p className="type-mono mt-1.5 !text-[0.75rem] !text-[var(--text)]">
                    {issue.detector}
                  </p>
                </div>
                <div>
                  <p className="type-label">Environment</p>
                  <p className="type-mono mt-1.5 !text-[0.75rem] !text-[var(--text)]">
                    {issue.environment}
                  </p>
                </div>
              </dl>
            </section>
          </div>
        ) : null}

        {tab === "runs" ? (
          <div className="px-5 py-6 sm:px-6">
            {runs.length === 0 ? (
              <EmptyState title="No linked runs" />
            ) : (
              <ul className="overflow-hidden rounded-[var(--radius)] shadow-[0_0_0_1px_var(--line)]">
                {runs.map((trace) => {
                  const errStep = trace.steps.find((s) => s.status === "error");
                  return (
                    <li
                      key={trace.id}
                      className="border-b border-[var(--line)] last:border-b-0"
                    >
                      <Link
                        href={hrefFor("/traces", {
                          id: trace.id,
                          tab: "signals",
                          agent: issue.agentId,
                        })}
                        className="block px-4 py-4 transition-colors hover:bg-[var(--accent-muted)]"
                      >
                        <div className="flex items-start gap-3">
                          <SeverityBadge severity={trace.severity} />
                          <div className="min-w-0 flex-1">
                            <p className="type-ui text-[var(--text)]">{trace.name}</p>
                            <p className="type-meta mt-1">
                              {trace.startedAt} · {formatDuration(trace.durationMs)} ·{" "}
                              {formatTokens(trace.tokens)} ·{" "}
                              {formatUsd(trace.costUsd, 3)}
                            </p>
                            {errStep?.errorMessage || trace.signals.body ? (
                              <p className="type-meta mt-2 line-clamp-2 text-[var(--text-secondary)]">
                                {errStep?.errorMessage ?? trace.signals.body}
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}

        {tab === "fix" ? (
          <div className="space-y-5 px-5 py-6 sm:px-6">
            {issue.patchBlockedReason ? (
              <section className="rounded-[var(--radius)] border border-[var(--line)] bg-[var(--bg-inset)] px-4 py-3">
                <p className="type-label mb-1 text-[var(--warn)]">
                  Eden can’t draft a fix PR yet
                </p>
                <p className="type-body text-[var(--text-secondary)]">
                  {issue.patchBlockedMessage || issue.patchBlockedReason}
                </p>
                {issue.patchBlockedReason === "repo_not_connected" ? (
                  <Link
                    href={`/settings?agent=${issue.agentId}`}
                    className="ds-btn ds-btn-primary ds-btn-sm mt-3 inline-block"
                  >
                    Connect GitHub
                  </Link>
                ) : null}
              </section>
            ) : null}
            <section className="space-y-3">
              <p className="type-body text-[var(--text-secondary)]">
                {issue.suggestedFix ||
                  "Eden is still gathering evidence for a concrete fix."}
              </p>
            </section>
            <div className="flex flex-wrap gap-2">
              <Link
                href={`/improve?issue=${issue.id}&agent=${issue.agentId}`}
                className="ds-btn ds-btn-primary ds-btn-sm"
              >
                Improve
              </Link>
              <Link
                href={`/agent?thread=thr_empty&issueId=${issue.id}&agent=${issue.agentId}${
                  runs[0] ? `&traceId=${runs[0].id}` : ""
                }&ai_prompt=${encodeURIComponent(
                  `Explain ${issue.title} and propose a fix`,
                )}`}
                className="ds-btn ds-btn-outline ds-btn-sm"
              >
                Ask AI
              </Link>
              {runs[0] ? (
                <Link
                  href={hrefFor("/traces", {
                    id: runs[0].id,
                    tab: "signals",
                    agent: issue.agentId,
                  })}
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                >
                  Run
                </Link>
              ) : null}
              {agent ? (
                <Link
                  href={`/agents?id=${agent.id}`}
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                >
                  Fleet
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function LabIssuesInner() {
  const searchParams = useSearchParams();
  const paramId = searchParams.get("id") ?? searchParams.get("issueId");
  const { agentId, agent, setAgentId, hrefFor } = useAgentScope();
  const patchQuery = useQueryPatch();
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const queryClient = useQueryClient();
  const { pushToast } = useLabToast();
  // OPT-15: offset-paginated — the API caps a single page at 200 (we
  // request 50/page) so orgs with >1 page of issues no longer see a
  // silent, signal-free truncation at the oldest 50.
  const issuesQuery = useInfiniteQuery({
    queryKey: queryKeys.portal.issues(orgId),
    queryFn: ({ pageParam }) =>
      portalApi.issues(orgId!, { limit: ISSUES_PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage: IssueFixture[], allPages: IssueFixture[][]) => {
      if (lastPage.length < ISSUES_PAGE_SIZE) return undefined;
      return allPages.reduce((sum, page) => sum + page.length, 0);
    },
    enabled: Boolean(orgId),
    ...SHELL_QUERY,
  });
  const issuesData = useMemo(
    () => issuesQuery.data?.pages.flatMap((page) => page) ?? [],
    [issuesQuery.data],
  );

  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [query, setQuery] = useState("");
  /** Optimistic triage overlay — cleared after invalidate or on failure. */
  const [statusOverride, setStatusOverride] = useState<Record<string, IssueStatus>>(
    {},
  );
  const [selectedId, setSelectedId] = useState<string | null>(paramId);

  useEffect(() => {
    setSelectedId(paramId);
  }, [paramId]);

  const issues = useMemo(() => {
    return issuesData.map((issue) => ({
      ...issue,
      status: statusOverride[issue.id] ?? issue.status,
    }));
  }, [issuesData, statusOverride]);

  const setIssueStatus = useCallback(
    async (issueId: string, status: IssueStatus) => {
      if (!orgId) return;
      setStatusOverride((prev) => ({ ...prev, [issueId]: status }));
      try {
        await agentIssuesApi.setStatus(orgId, issueId, status);
        await queryClient.invalidateQueries({
          queryKey: queryKeys.portal.issues(orgId),
        });
        setStatusOverride((prev) => {
          const next = { ...prev };
          delete next[issueId];
          return next;
        });
      } catch (err) {
        setStatusOverride((prev) => {
          const next = { ...prev };
          delete next[issueId];
          return next;
        });
        pushToast({
          title: "Could not update issue",
          body: err instanceof Error ? err.message : String(err),
          tone: "fail",
        });
      }
    },
    [orgId, queryClient, pushToast],
  );

  /**
   * FEAT-10: soft-dismiss (status=ignored). Feeds the shadow-detector
   * confirm/dismiss loop (P0-A) on the backend when the issue's example
   * stumble came from the signal investigator. Not part of ``IssueStatus``
   * (the open/acknowledged/resolved kanban) so it skips the optimistic
   * ``statusOverride`` and just invalidates on success — the issue drops
   * out of the default list once refetched.
   */
  const dismissIssue = useCallback(
    async (issueId: string) => {
      if (!orgId) return;
      try {
        await agentIssuesApi.resolve(orgId, issueId, "ignored");
        await queryClient.invalidateQueries({
          queryKey: queryKeys.portal.issues(orgId),
        });
      } catch (err) {
        pushToast({
          title: "Could not dismiss issue",
          body: err instanceof Error ? err.message : String(err),
          tone: "fail",
        });
      }
    },
    [orgId, queryClient, pushToast],
  );

  const scopedIssues = useMemo(() => {
    if (agentId === "all") return issues;
    return issues.filter((issue) => issue.agentId === agentId);
  }, [issues, agentId]);

  const agentCounts = useMemo(() => agentScopeCounts(issues), [issues]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scopedIssues.filter((issue) => {
      if (severityFilter !== "all" && issue.severity !== severityFilter) {
        return false;
      }
      if (!q) return true;
      const issueAgent = agentForIssue(issue);
      return (
        issue.title.toLowerCase().includes(q) ||
        issue.summary.toLowerCase().includes(q) ||
        issue.body.toLowerCase().includes(q) ||
        issue.fingerprint.toLowerCase().includes(q) ||
        issue.errorSample.toLowerCase().includes(q) ||
        issue.tags.some((t) => t.includes(q)) ||
        (issueAgent?.name.toLowerCase().includes(q) ?? false)
      );
    });
  }, [scopedIssues, severityFilter, query]);

  const byColumn = useMemo(() => {
    const map: Record<IssueStatus, IssueFixture[]> = {
      open: [],
      acknowledged: [],
      resolved: [],
      // Never populated: the read-model maps "ignored" -> "resolved"
      // before an IssueFixture reaches the client (see IssueStatus).
      ignored: [],
    };
    for (const issue of filtered) {
      map[issue.status].push(issue);
    }
    return map;
  }, [filtered]);

  const boardRows = useMemo<IssueBoardRow[]>(() => {
    const out: IssueBoardRow[] = [];
    for (const col of COLUMNS) {
      const items = byColumn[col.id];
      if (items.length === 0) continue;
      out.push({
        kind: "header",
        key: `header:${col.id}`,
        column: col.id,
        label: col.label,
        count: items.length,
      });
      for (const issue of items) {
        out.push({ kind: "issue", key: issue.id, issue });
      }
    }
    return out;
  }, [byColumn]);

  // Section headers keep their sticky behaviour: the range extractor
  // pins whichever header precedes the visible window so it stays
  // mounted, and that one row renders `position: sticky` instead of
  // absolute (every other row is out of flow, so the sticky one is
  // free to travel the whole scrollport). Mirrors traces-client.tsx.
  const boardStickyIndexes = useMemo(() => {
    const out: number[] = [];
    boardRows.forEach((row, i) => {
      if (row.kind === "header") out.push(i);
    });
    return out;
  }, [boardRows]);
  const activeStickyBoardIndexRef = useRef(-1);

  const boardScrollRef = useRef<HTMLDivElement | null>(null);
  const boardRangeExtractor = useCallback(
    (range: { startIndex: number; endIndex: number; overscan: number; count: number }) => {
      let sticky = -1;
      for (const i of boardStickyIndexes) {
        if (i <= range.startIndex) sticky = i;
        else break;
      }
      activeStickyBoardIndexRef.current = sticky;
      const next = new Set(defaultRangeExtractor(range));
      if (sticky >= 0) next.add(sticky);
      return [...next].sort((a, b) => a - b);
    },
    [boardStickyIndexes],
  );

  const boardVirtualizer = useVirtualizer({
    count: boardRows.length,
    getScrollElement: () => boardScrollRef.current,
    estimateSize: (index) =>
      boardRows[index]?.kind === "header"
        ? ISSUE_HEADER_ESTIMATE
        : ISSUE_ROW_ESTIMATE,
    overscan: 8,
    getItemKey: (index) => boardRows[index]?.key ?? index,
    rangeExtractor: boardRangeExtractor,
    measureElement: measureVirtualRow,
  });

  const selectIssue = useCallback(
    (id: string) => {
      setSelectedId(id);
      patchQuery({ id });
    },
    [patchQuery],
  );

  function clearSelection() {
    setSelectedId(null);
    patchQuery({ id: null });
  }

  const selected = selectedId
    ? (filtered.find((i) => i.id === selectedId) ??
      issues.find((i) => i.id === selectedId) ??
      null)
    : null;

  const severityCounts = useMemo(
    () => ({
      all: scopedIssues.length,
      error: scopedIssues.filter((i) => i.severity === "error").length,
      warn: scopedIssues.filter((i) => i.severity === "warn").length,
    }),
    [scopedIssues],
  );

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Issues"
        message="Select a workspace to view issues."
      />
    );
  }

  if (issuesQuery.isLoading) {
    return (
      <div className="ds-page">
        <PageHeader title="Issues" />
        <QueryLoadingPanel label="Loading issues…" />
      </div>
    );
  }

  if (issuesQuery.isError) {
    return (
      <div className="ds-page">
        <PageHeader title="Issues" />
        <QueryErrorPanel
          error={issuesQuery.error}
          onRetry={() => void issuesQuery.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="ds-page">
      <PageHeader
        title="Issues"
        meta={
          <span className="type-meta">
            {agent ? agent.name : "All agents"} · {byColumn.open.length} open
          </span>
        }
        actions={<SavedViewsMenu />}
      />

      <div className="flex min-h-0 min-w-0 flex-1">
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
            selected ? "hidden lg:flex" : "flex",
          )}
        >
          <div className="lab-list-chrome border-b border-[var(--line)] sm:!flex-row sm:flex-wrap sm:items-end">
            <div className="min-w-[12rem] flex-1 space-y-2 sm:max-w-xs">
              <p className="type-label">Agent</p>
              <AgentScopeFilter
                value={agentId}
                onChange={setAgentId}
                counts={agentCounts}
              />
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <p className="type-label">Search</p>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                className="ds-input w-full"
                aria-label="Search issues"
              />
            </div>
            <div className="space-y-2">
              <p className="type-label">Severity</p>
              <FilterChips
                value={severityFilter}
                onChange={setSeverityFilter}
                options={[
                  { id: "all", label: "All", count: severityCounts.all },
                  { id: "error", label: "Fail", count: severityCounts.error },
                  { id: "warn", label: "Warn", count: severityCounts.warn },
                ]}
              />
            </div>
          </div>

          <div
            ref={boardScrollRef}
            className="min-h-0 flex-1 overflow-y-auto"
            {...{ [VIRTUAL_SCROLL_ATTR]: "issues-board" }}
          >
            {filtered.length === 0 ? (
              <EmptyState
                title={
                  agent
                    ? `No issues for ${agent.name}`
                    : scopedIssues.length === 0
                      ? "No issues yet"
                      : "No matching issues"
                }
                body={
                  query.trim() || severityFilter !== "all" || agent
                    ? U20_FILTER_EMPTY_COPY.issues
                    : U20_EMPTY_COPY.issues
                }
              />
            ) : (
              <ul
                role="list"
                aria-label="Issues"
                className="relative pb-2"
                style={{ height: `${boardVirtualizer.getTotalSize()}px` }}
              >
                {boardVirtualizer.getVirtualItems().map((item) => {
                  const row = boardRows[item.index];
                  if (!row) return null;
                  const isStuck =
                    row.kind === "header" &&
                    activeStickyBoardIndexRef.current === item.index;
                  return (
                    <li
                      key={item.key}
                      ref={boardVirtualizer.measureElement}
                      data-index={item.index}
                      role={row.kind === "header" ? "presentation" : undefined}
                      className={cn(
                        "w-full min-w-0",
                        isStuck
                          ? "sticky top-0 z-[2]"
                          : "absolute top-0 left-0",
                      )}
                      style={
                        isStuck
                          ? undefined
                          : { transform: `translateY(${item.start}px)` }
                      }
                    >
                      {row.kind === "header" ? (
                        <header
                          aria-label={`${row.label} issues`}
                          className="flex items-baseline justify-between gap-2 border-b border-[var(--line)] bg-[var(--bg-inset)] px-4 py-2 sm:px-5"
                        >
                          <h3 className="type-label text-[var(--text)]">{row.label}</h3>
                          <span className="type-value tabular-nums">{row.count}</span>
                        </header>
                      ) : (
                        <IssueRow
                          issue={row.issue}
                          active={row.issue.id === selected?.id}
                          onSelect={() => selectIssue(row.issue.id)}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {issuesQuery.hasNextPage ? (
              <div className="flex justify-center border-t border-[var(--line)] px-4 py-3">
                <button
                  type="button"
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                  onClick={() => void issuesQuery.fetchNextPage()}
                  disabled={issuesQuery.isFetchingNextPage}
                >
                  {issuesQuery.isFetchingNextPage ? "Loading…" : "Load more"}
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {selected ? (
          <IssueDetail
            issue={selected}
            hrefFor={hrefFor}
            onClose={clearSelection}
            onStatus={(status) => {
              void setIssueStatus(selected.id, status);
            }}
            onDismiss={() => {
              void dismissIssue(selected.id);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

export default function LabIssuesPage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page">
          <PageHeader title="Issues" meta={<span className="type-meta">Loading…</span>} />
        </div>
      }
    >
      <LabIssuesInner />
    </Suspense>
  );
}
