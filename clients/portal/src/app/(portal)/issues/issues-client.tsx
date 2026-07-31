"use client";

import Link from "next/link";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useSearchParams } from "next/navigation";
import { X } from "lucide-react";
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
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { SHELL_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { U20_EMPTY_COPY, U20_FILTER_EMPTY_COPY } from "@/lib/portal-polish";

type SeverityFilter = "all" | "error" | "warn";
type DetailTab = "overview" | "runs" | "fix";

/** Deep-linkable via ``?tab=``; anything else falls back to overview. */
const DETAIL_TABS: readonly DetailTab[] = ["overview", "runs", "fix"] as const;

const COLUMNS: { id: IssueStatus; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "acknowledged", label: "In progress" },
  { id: "resolved", label: "Resolved" },
];

function statusTone(status: IssueStatus): "fail" | "neutral" | "ok" {
  if (status === "open") return "fail";
  if (status === "acknowledged") return "neutral";
  return "ok";
}

function IssueStatusChip({ status }: { status: IssueStatus }) {
  const label =
    status === "acknowledged"
      ? "in progress"
      : status === "resolved"
        ? "resolved"
        : "open";
  return <StatusChip tone={statusTone(status)}>{label}</StatusChip>;
}

function IssueCard({
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
        "w-full rounded-[var(--radius-lg)] p-4 text-left transition-colors",
        "shadow-[0_0_0_1px_var(--line)]",
        active
          ? "bg-[var(--accent-muted)] shadow-[0_0_0_1px_var(--accent)]"
          : "bg-[var(--bg)] hover:bg-[var(--accent-muted)]",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <SeverityBadge severity={issue.severity} />
        <span className="type-value tabular-nums !text-[0.625rem]">
          {issue.occurrenceTraceIds.length}×
        </span>
      </div>
      <p className="type-ui mt-3 text-[var(--text)]">{issue.title}</p>
      <p className="type-body mt-1.5 line-clamp-2">{issue.summary}</p>
      <p className="type-meta mt-3">
        {agent?.name ?? "unknown"} · {issue.lastSeen}
      </p>
    </button>
  );
}

function IssueDetail({
  issue,
  onStatus,
  onClose,
  hrefFor,
}: {
  issue: IssueFixture;
  onStatus: (status: IssueStatus) => void;
  onClose: () => void;
  hrefFor: (base: string, extra?: Record<string, string | undefined>) => string;
}) {
  const agent = agentForIssue(issue);
  const runs = occurrencesForIssue(issue);
  // ``?tab=`` makes the detail tabs deep-linkable. The retired
  // ``/issues/:id/fix`` page redirects here with ``tab=fix``; without
  // this the redirect would land on Overview and silently drop intent.
  const searchParams = useSearchParams();
  const paramTab = searchParams.get("tab");
  const initialTab: DetailTab = DETAIL_TABS.includes(paramTab as DetailTab)
    ? (paramTab as DetailTab)
    : "overview";
  const [tab, setTab] = useState<DetailTab>(initialTab);

  useEffect(() => {
    setTab(initialTab);
  }, [issue.id, initialTab]);

  return (
    <aside
      className="flex w-full max-w-xl shrink-0 flex-col overflow-hidden border-l border-[var(--line)] bg-[var(--bg)]"
      aria-label="Issue detail"
    >
      <header className="shrink-0 border-b border-[var(--line)] px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
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
            className="ds-btn ds-btn-ghost ds-btn-icon"
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
                Resolve
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
                Resolve
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
            onClick={() => setTab(t.id)}
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
            <section className="space-y-3">
              <p className="type-body text-[var(--text-secondary)]">
                {issue.suggestedFix}
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
  const paramId = searchParams.get("id");
  const { agentId, agent, setAgentId, hrefFor } = useAgentScope();
  const patchQuery = useQueryPatch();
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const issuesQuery = useOrgQuery(
    queryKeys.portal.issues(orgId),
    orgId,
    () => portalApi.issues(orgId!),
    SHELL_QUERY,
  );
  const issuesData = issuesQuery.data ?? [];

  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [query, setQuery] = useState("");
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
    };
    for (const issue of filtered) {
      map[issue.status].push(issue);
    }
    return map;
  }, [filtered]);

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
      />

      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
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

          <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
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
              <div className="flex h-full min-w-[48rem] gap-4 px-5 py-5 sm:px-7">
                {COLUMNS.map((col) => {
                  const items = byColumn[col.id];
                  return (
                    <section
                      key={col.id}
                      className="flex min-h-0 w-[min(20rem,32vw)] shrink-0 flex-col"
                      aria-label={`${col.label} issues`}
                    >
                      <header className="mb-3 flex shrink-0 items-baseline justify-between gap-2">
                        <h3 className="type-ui text-[var(--text)]">{col.label}</h3>
                        <span className="type-value tabular-nums">
                          {items.length}
                        </span>
                      </header>
                      <ul className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-2">
                        {items.length === 0 ? (
                          <li className="rounded-[var(--radius-lg)] px-3 py-8 text-center shadow-[0_0_0_1px_var(--line)]">
                            <p className="type-meta">—</p>
                          </li>
                        ) : (
                          items.map((issue) => (
                            <li key={issue.id}>
                              <IssueCard
                                issue={issue}
                                active={issue.id === selected?.id}
                                onSelect={() => selectIssue(issue.id)}
                              />
                            </li>
                          ))
                        )}
                      </ul>
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {selected ? (
          <IssueDetail
            issue={selected}
            hrefFor={hrefFor}
            onClose={clearSelection}
            onStatus={(status) =>
              setStatusOverride((prev) => ({ ...prev, [selected.id]: status }))
            }
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
