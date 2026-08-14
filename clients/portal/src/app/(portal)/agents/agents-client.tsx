"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  PanelLeftClose,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Pencil,
  Radar,
  X,
} from "lucide-react";
import {
  tracesForAgent,
  type AgentFixture,
} from "@/lab/fixtures/agents";
import {
  formatDuration,
  formatTokens,
  formatUsd,
  preferKnownCostUsd,
  sortTracesNewestFirst,
  type TraceFixture,
} from "@/lab/fixtures/traces";
import { PageHeader } from "@/components/ds/primitives";
import { useQueryPatch } from "@/lab/agent-scope";
import { useListKeyboard, useMinWidth, usePersistentBool } from "@/lab/hooks";
import {
  AgentStatusBadge,
  EmptyState,
  errorStepIds,
  FilterChips,
  ListRevealButton,
  RunListButton,
  RunMeta,
  RunTranscript,
  SearchInput,
  SeverityBadge,
} from "@/lab/lab-ui";
import { MetricCell } from "@/lab/lab-metric-cell";
import { cn } from "@/lib/utils";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { SHELL_QUERY, LIVE_STALE } from "@/lib/portal-query";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";
import {
  InlineLoading,
  QueryErrorPanel,
  QueryLoadingPanel,
} from "@/components/shell/query-error-panel";
import { AgentHealthStrip } from "@/components/agents/agent-health-strip";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { useLabToast } from "@/lab/lab-toast";
import { formatRelativeTime } from "@/lib/format";
import { HelpInstallBar } from "./help-panel";

const ConnectRepoButton = dynamic(
  () =>
    import("@/components/agents/ConnectRepoButton").then((m) => ({
      default: m.ConnectRepoButton,
    })),
  {
    ssr: false,
    loading: () => (
      <span className="ds-btn ds-btn-outline ds-btn-sm pointer-events-none opacity-60">
        Repo…
      </span>
    ),
  },
);

// Detail tabs are code-split — Quality pulls the recharts island (via its
// own inner dynamic import) and Experiments pulls the offline experiments
// client, neither of which should ride along on /agents first paint.
const AgentQualityTab = dynamic(
  () =>
    import("@/components/agents/agent-quality-tab").then((m) => ({
      default: m.AgentQualityTab,
    })),
  { ssr: false, loading: () => <QueryLoadingPanel label="Loading quality…" /> },
);

const AgentDelegationTab = dynamic(
  () =>
    import("@/components/agents/agent-delegation-tab").then((m) => ({
      default: m.AgentDelegationTab,
    })),
  { ssr: false, loading: () => <QueryLoadingPanel label="Loading delegation graph…" /> },
);

const AgentExperimentsTab = dynamic(
  () =>
    import("@/components/agents/agent-experiments-tab").then((m) => ({
      default: m.AgentExperimentsTab,
    })),
  {
    ssr: false,
    loading: () => <QueryLoadingPanel label="Loading experiments…" />,
  },
);

type RunFilter = "all" | "error" | "warn" | "ok";

// BUG-7: matches ``UNATTRIBUTED_AGENT_ID`` in
// ``src/eden/api/routes/portal.py`` — the synthetic card the backend
// emits for telemetry/issues that never got an agent_id stamped. It is
// not a selectable agent (there is no real registry entry, rename
// target, or agent-scoped trace query for it), so the fleet list and
// detail pane special-case it into its own summary row instead.
const UNATTRIBUTED_AGENT_ID = "unattributed";

type DetailTab = "runs" | "quality" | "experiments" | "delegation";

function parseDetailTab(raw: string | null): DetailTab {
  if (raw === "quality" || raw === "experiments" || raw === "delegation") return raw;
  return "runs";
}

const DETAIL_TABS: Array<{ id: DetailTab; label: string }> = [
  { id: "runs", label: "Runs" },
  { id: "quality", label: "Quality" },
  { id: "experiments", label: "Experiments" },
  { id: "delegation", label: "Delegation" },
];

function RunInspector({
  trace,
  agent,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  stepsLoading,
  stepsError,
  onRetrySteps,
}: {
  trace: TraceFixture;
  agent: AgentFixture;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  stepsLoading?: boolean;
  stepsError?: Error | null;
  onRetrySteps?: () => void;
}) {
  const { currentOrg } = useOrg();
  const hasSignals = trace.severity !== "none" || Boolean(trace.signals?.title);
  const [signalDismissed, setSignalDismissed] = useState(false);

  useEffect(() => {
    setSignalDismissed(false);
  }, [trace.id]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="shrink-0 border-b border-[var(--line)] px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityBadge severity={trace.severity} />
              <h3 className="type-ui min-w-0 truncate text-[var(--text)]">{trace.name}</h3>
            </div>
            <p className="type-meta mt-1.5">
              Run in agent <span className="text-[var(--text)]">{agent.name}</span>
              {" · "}
              {formatRelativeTime(trace.startedAt)}
              {" · "}
              <span className="font-mono text-[0.7rem]">{trace.id.slice(0, 12)}</span>
            </p>
            <div className="mt-2">
              <RunMeta trace={trace} />
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              disabled={!hasPrev}
              onClick={onPrev}
              aria-label="Newer run"
              title="Newer run"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Newer
            </button>
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              disabled={!hasNext}
              onClick={onNext}
              aria-label="Older run"
              title="Older run"
            >
              Older
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <Link
              href={`/traces?id=${trace.id}&agent=${agent.id}${hasSignals ? "&tab=signals" : ""}`}
              className="ds-btn ds-btn-ghost ds-btn-sm"
            >
              Open
              <ExternalLink className="h-3 w-3" aria-hidden />
            </Link>
          </div>
        </div>
      </header>

      {hasSignals && !signalDismissed ? (
        <div
          className={cn(
            "shrink-0 border-b border-[var(--line)] px-4 py-3 sm:px-5",
            trace.severity === "error" && "bg-[var(--error-muted)]",
            trace.severity === "warn" && "bg-[var(--error-muted)]",
          )}
          role="status"
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={trace.severity} />
                  <p className="type-ui text-[var(--text)]">{trace.signals.title}</p>
                </div>
                {trace.signals.count ? (
                  <span className="type-mono">{trace.signals.count}</span>
                ) : null}
              </div>
              <p className="type-body mt-1.5 text-[var(--text-secondary)]">
                {trace.signals.body}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSignalDismissed(true)}
              className="ds-btn ds-btn-ghost ds-btn-icon shrink-0"
              aria-label="Dismiss signals"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : hasSignals && signalDismissed ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--line)] px-4 py-2 sm:px-5">
          <p className="type-meta">Signals dismissed</p>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={() => setSignalDismissed(false)}
          >
            Show signals
          </button>
        </div>
      ) : null}

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {stepsError ? (
          <div className="p-6">
            <QueryErrorPanel
              error={stepsError}
              onRetry={onRetrySteps}
            />
          </div>
        ) : stepsLoading && trace.steps.length === 0 ? (
          <QueryLoadingPanel label="Loading transcript…" />
        ) : !stepsLoading && trace.steps.length === 0 ? (
          <EmptyState
            icon={Radar}
            title="No spans"
            body="This run has no span events yet, or the transcript could not be reconstructed."
            compact
            action={
              onRetrySteps ? (
                <button
                  type="button"
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                  onClick={onRetrySteps}
                >
                  Retry
                </button>
              ) : undefined
            }
          />
        ) : (
          <RunTranscript
            key={trace.id}
            steps={trace.steps}
            defaultOpenIds={errorStepIds(trace.steps)}
            orgId={currentOrg?.id ?? null}
            traceId={trace.id}
          />
        )}
      </div>
    </div>
  );
}

function AgentDetail({
  agent,
  onBackToList,
}: {
  agent: AgentFixture | null;
  onBackToList?: () => void;
}) {
  if (!agent) {
    return (
      <div className="space-y-4 p-5">
        <EmptyState
          icon={Bot}
          title="No agents yet"
          body={U20_EMPTY_COPY.agents}
        />
        <div className="flex flex-wrap gap-2">
          <Link href="/settings?mode=keys" className="ds-btn ds-btn-primary ds-btn-sm">
            API keys
          </Link>
        </div>
      </div>
    );
  }

  return <AgentDetailBody agent={agent} onBackToList={onBackToList} />;
}

function AgentDetailBody({
  agent,
  onBackToList,
}: {
  agent: AgentFixture;
  onBackToList?: () => void;
}) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const queryClient = useQueryClient();
  const { pushToast } = useLabToast();
  const searchParams = useSearchParams();
  const patchQuery = useQueryPatch();
  const detailTab = parseDetailTab(searchParams.get("tab"));
  const setDetailTab = useCallback(
    (next: DetailTab) => {
      patchQuery({ tab: next === "runs" ? null : next });
    },
    [patchQuery],
  );
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(agent.name);
  const [renameBusy, setRenameBusy] = useState(false);

  useEffect(() => {
    setDraftName(agent.name);
    setRenaming(false);
  }, [agent.id, agent.name]);

  const saveName = useCallback(async () => {
    if (!orgId) return;
    const next = draftName.trim();
    if (!next || next === agent.name) {
      setRenaming(false);
      setDraftName(agent.name);
      return;
    }
    setRenameBusy(true);
    try {
      await portalApi.renameAgent(orgId, agent.id, next);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.portal.agents(orgId),
      });
      pushToast({
        title: "Agent renamed",
        body: `Now showing as “${next}”. The agent id stays ${agent.id}.`,
        tone: "ok",
      });
      setRenaming(false);
    } catch (err) {
      pushToast({
        title: "Couldn't rename agent",
        body: err instanceof Error ? err.message : "Try again",
        tone: "fail",
      });
    } finally {
      setRenameBusy(false);
    }
  }, [agent.id, agent.name, draftName, orgId, pushToast, queryClient]);

  // OPT-14: scope the traces query to this agent server-side instead of
  // fetching the org-wide most-recent-50/24h list and filtering
  // client-side — that used to render an empty run list for an agent
  // whose activity was older than the org's most-recent traces, even
  // though the agent genuinely had runs.
  const tracesQuery = useOrgQuery(
    queryKeys.portal.traces(orgId, agent.id),
    orgId,
    () => portalApi.traces(orgId!, { agentId: agent.id }),
    SHELL_QUERY,
  );
  const runs = useMemo(() => {
    const fromApi = tracesQuery.data ?? [];
    const source =
      fromApi.length > 0 ? fromApi : tracesForAgent(agent.id);
    return sortTracesNewestFirst(source);
  }, [agent.id, tracesQuery.data]);
  const failures = useMemo(
    () => runs.filter((t) => t.severity === "error"),
    [runs],
  );
  const warnings = useMemo(
    () => runs.filter((t) => t.severity === "warn"),
    [runs],
  );

  const [runFilter, setRunFilter] = useState<RunFilter>("all");
  const [selectedRunId, setSelectedRunId] = useState(runs[0]?.id ?? "");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const prefer =
      runs.find((t) => t.severity === "error")?.id ??
      runs.find((t) => t.severity === "warn")?.id ??
      runs[0]?.id ??
      "";
    setSelectedRunId(prefer);
    setRunFilter("all");
    setQuery("");
    // Only reset when switching agents — `runs` identity changes on
    // every traces refetch and used to yank selection back to the
    // newest error mid-inspection.
  }, [agent.id]);

  // If the preferred run disappeared after a refetch, fall back once.
  useEffect(() => {
    if (runs.length === 0) {
      setSelectedRunId("");
      return;
    }
    if (!runs.some((t) => t.id === selectedRunId)) {
      setSelectedRunId(
        runs.find((t) => t.severity === "error")?.id ??
          runs.find((t) => t.severity === "warn")?.id ??
          runs[0]?.id ??
          "",
      );
    }
  }, [runs, selectedRunId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs.filter((t) => {
      if (runFilter === "error" && t.severity !== "error") return false;
      if (runFilter === "warn" && t.severity !== "warn") return false;
      if (runFilter === "ok" && t.severity !== "none") return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        t.signals.title.toLowerCase().includes(q)
      );
    });
  }, [runs, runFilter, query]);

  const selectedListItem =
    filtered.find((t) => t.id === selectedRunId) ??
    runs.find((t) => t.id === selectedRunId);

  const selectedRunIdForDetail = selectedRunId || selectedListItem?.id || "";
  const traceDetailQuery = useOrgQuery(
    queryKeys.portal.traceDetail(orgId, selectedRunIdForDetail || null),
    orgId,
    ({ signal }) =>
      portalApi.traceDetail(orgId!, selectedRunIdForDetail, signal),
    {
      ...SHELL_QUERY,
      staleTime: 30_000,
      // Refetch when stale only — "always" defeated soft-nav cache.
      refetchOnMount: true,
      enabled: Boolean(orgId) && Boolean(selectedRunIdForDetail),
    },
  );

  // List rows ship steps: [] — hydrate the selected run like traces-client.
  const selected = useMemo(() => {
    const detail = traceDetailQuery.data;
    if (detail && detail.id === selectedRunIdForDetail) {
      const base = selectedListItem ?? detail;
      const stepCosts = Array.isArray(detail.steps)
        ? detail.steps
            .map((s) => s.costUsd)
            .filter((c): c is number => c != null && Number.isFinite(c))
        : [];
      const stepCost =
        stepCosts.length > 0 ? stepCosts.reduce((sum, c) => sum + c, 0) : null;
      const costUsd = preferKnownCostUsd(detail.costUsd, base.costUsd, stepCost);
      return {
        ...base,
        ...detail,
        steps: Array.isArray(detail.steps) ? detail.steps : [],
        costUsd,
        tokens: detail.tokens || base.tokens,
        signals: detail.signals?.title ? detail.signals : base.signals,
      };
    }
    return selectedListItem;
  }, [selectedListItem, traceDetailQuery.data, selectedRunIdForDetail]);

  useEffect(() => {
    if (!selected) return;
    if (!filtered.some((t) => t.id === selected.id) && filtered[0]) {
      setSelectedRunId(filtered[0].id);
    }
  }, [filtered, selected]);

  const selectedIndex = selected
    ? filtered.findIndex((t) => t.id === selected.id)
    : -1;

  const selectRelative = useCallback(
    (delta: number) => {
      if (!filtered.length) return;
      const idx = selectedIndex < 0 ? 0 : selectedIndex;
      const next =
        filtered[Math.min(filtered.length - 1, Math.max(0, idx + delta))];
      if (next) setSelectedRunId(next.id);
    },
    [filtered, selectedIndex],
  );

  useListKeyboard({
    move: selectRelative,
  });

  useEffect(() => {
    if (!selected) return;
    document
      .querySelector(`[data-run-id="${selected.id}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected?.id]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-[var(--line)] px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              {onBackToList ? (
                <button
                  type="button"
                  className="ds-btn ds-btn-ghost ds-btn-icon lg:hidden"
                  onClick={onBackToList}
                  aria-label="Back to fleet"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
              ) : null}
              {renaming ? (
                <form
                  className="flex min-w-0 flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveName();
                  }}
                >
                  <input
                    className="ds-input max-w-xs"
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    autoFocus
                    maxLength={200}
                    aria-label="Agent display name"
                    disabled={renameBusy}
                  />
                  <button
                    type="submit"
                    className="ds-btn ds-btn-primary ds-btn-sm"
                    disabled={renameBusy || !draftName.trim()}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="ds-btn ds-btn-ghost ds-btn-sm"
                    disabled={renameBusy}
                    onClick={() => {
                      setRenaming(false);
                      setDraftName(agent.name);
                    }}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <h2 className="type-ui !text-[1.0625rem]">{agent.name}</h2>
                  <button
                    type="button"
                    className="ds-btn ds-btn-ghost ds-btn-icon"
                    aria-label="Rename agent"
                    title="Rename agent"
                    onClick={() => setRenaming(true)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
              <AgentStatusBadge status={agent.status} />
            </div>
            <p className="type-meta">
              <span className="font-mono">{agent.id}</span>
              {agent.model ? <> · {agent.model}</> : null}
              {" · "}
              {agent.lastSeen
                ? <>last telemetry {formatRelativeTime(agent.lastSeen)}</>
                : <>no recent activity</>}
              {agent.topError ? (
                <>
                  {" · "}
                  <span className="text-[var(--error)]">{agent.topError}</span>
                </>
              ) : null}
              {agent.mergedIdentities && agent.mergedIdentities.length > 0 ? (
                <>
                  {" · "}
                  <span
                    className="text-[var(--muted-foreground)]"
                    title={`Reconciled telemetry labels: ${agent.mergedIdentities.join(", ")}`}
                  >
                    merged {agent.mergedIdentities.length} telemetry{" "}
                    {agent.mergedIdentities.length === 1 ? "label" : "labels"}
                  </span>
                </>
              ) : null}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {/* Sidebar already covers Traces / Improve / Issues / etc. */}
            <ConnectRepoButton agentId={agent.id} />
          </div>
        </div>
      </header>

      <AgentHealthStrip
        lastSeen={agent.lastSeen}
        errorRate={agent.errorRate}
        openIssues={agent.openIssues}
        runs24h={agent.runs24h}
      />

      <div className="lab-metric-strip shrink-0 [&_>_*]:!px-4 [&_>_*]:!py-3">
        <MetricCell label="Runs (24h)" value={String(agent.runs24h)} />
        <MetricCell
          label="Success"
          value={
            agent.runs24h > 0 && agent.successRate != null
              ? `${(agent.successRate * 100).toFixed(0)}%`
              : "—"
          }
          hint={
            agent.runs24h <= 0
              ? "no runs in window"
              : agent.successRate == null
                ? "outcomes not scored yet"
                : agent.errorRate != null
                  ? `${(agent.errorRate * 100).toFixed(0)}% errors`
                  : undefined
          }
          tone={
            agent.runs24h <= 0 || agent.successRate == null
              ? "default"
              : agent.successRate < 0.8
                ? "error"
                : agent.successRate >= 0.95
                  ? "ok"
                  : "default"
          }
        />
        <MetricCell
          label="Latency p50 / p95"
          value={
            agent.runs24h > 0 && agent.p50Ms > 0
              ? formatDuration(agent.p50Ms)
              : "—"
          }
          hint={
            agent.runs24h > 0 && agent.p95Ms > 0
              ? formatDuration(agent.p95Ms)
              : undefined
          }
        />
        <MetricCell
          label="Spend"
          value={formatUsd(agent.costUsd24h)}
          hint={
            agent.costUsd24h != null && agent.runs24h > 0
              ? `${formatTokens(agent.tokens24h)} · ${formatUsd(agent.costUsd24h / agent.runs24h, 3)}/run`
              : agent.costUsd24h != null
                ? formatTokens(agent.tokens24h)
                : agent.runs24h > 0
                  ? "cost not available"
                  : undefined
          }
        />
        <MetricCell
          label="Issues"
          value={String(agent.openIssues)}
          tone={agent.openIssues > 0 ? "error" : "default"}
          hint={`${failures.length} failed · ${warnings.length} warning in list`}
        />
      </div>

      <div
        role="tablist"
        aria-label="Agent detail sections"
        className="flex shrink-0 gap-1 border-b border-[var(--line)] px-4 py-1.5 sm:px-5"
      >
        {DETAIL_TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={detailTab === id}
            className="ds-tab"
            onClick={() => setDetailTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {detailTab === "quality" ? (
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <AgentQualityTab orgId={orgId} agentId={agent.id} />
        </div>
      ) : detailTab === "experiments" ? (
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <AgentExperimentsTab orgId={orgId} agentId={agent.id} />
        </div>
      ) : detailTab === "delegation" ? (
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <AgentDelegationTab orgId={orgId} agentId={agent.id} />
        </div>
      ) : (
      <div className="grid min-h-0 min-w-0 flex-1 lg:grid-cols-[minmax(16rem,24rem)_minmax(0,1fr)]">
        <section className="flex min-h-0 min-w-0 flex-col border-b border-[var(--line)] lg:border-b-0 lg:border-r">
          <div className="lab-list-chrome">
            <div className="flex items-center justify-between gap-2">
              <p className="type-ui text-[var(--text)]">Runs</p>
              <span className="type-mono">
                {selectedIndex >= 0 ? selectedIndex + 1 : 0}/{filtered.length}
              </span>
            </div>
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Search runs, ids…"
              ariaLabel="Filter runs"
            />
            <FilterChips
              value={runFilter}
              onChange={setRunFilter}
              scroll
              options={[
                { id: "all", label: "All", count: runs.length },
                { id: "error", label: "Failed", count: failures.length },
                { id: "warn", label: "Warning", count: warnings.length },
                {
                  id: "ok",
                  label: "OK",
                  count: runs.filter((t) => t.severity === "none").length,
                },
              ]}
            />
          </div>

          <ul className="min-h-0 flex-1 overflow-y-auto">
            {tracesQuery.isError ? (
              <li className="p-4">
                <QueryErrorPanel
                  error={tracesQuery.error}
                  onRetry={() => void tracesQuery.refetch()}
                />
              </li>
            ) : filtered.length === 0 ? (
              <li>
                <EmptyState
                  icon={Bot}
                  title={
                    runs.length === 0
                      ? !tracesQuery.isLoading && agent.runs24h > 0
                        ? "Runs outside this list window"
                        : "No runs in this window"
                      : "No matching runs"
                  }
                  body={
                    runs.length === 0
                      ? !tracesQuery.isLoading && agent.runs24h > 0
                        ? "This agent has runs in the last 24h, but none match the current traces feed window."
                        : "Traces show up here after this agent sends telemetry."
                      : undefined
                  }
                />
              </li>
            ) : (
              filtered.map((trace) => (
                <li key={trace.id} className="min-w-0">
                  <RunListButton
                    trace={trace}
                    active={selected?.id === trace.id}
                    onSelect={setSelectedRunId}
                  />
                </li>
              ))
            )}
          </ul>
        </section>

        <section className="min-h-0 min-w-0 overflow-hidden">
          {selected ? (
            <RunInspector
              trace={selected}
              agent={agent}
              hasPrev={selectedIndex > 0}
              hasNext={selectedIndex >= 0 && selectedIndex < filtered.length - 1}
              onPrev={() => selectRelative(-1)}
              onNext={() => selectRelative(1)}
              stepsLoading={traceDetailQuery.isLoading}
              stepsError={
                traceDetailQuery.isError
                  ? (traceDetailQuery.error as Error)
                  : undefined
              }
              onRetrySteps={() => void traceDetailQuery.refetch()}
            />
          ) : (
            <EmptyState icon={Radar} title="Select a run" />
          )}
        </section>
      </div>
      )}
    </div>
  );
}

function LabAgentsInner() {
  const searchParams = useSearchParams();
  const paramId = searchParams.get("id");
  const patchQuery = useQueryPatch();
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const agentsQuery = useOrgQuery(
    queryKeys.portal.agents(orgId),
    orgId,
    () => portalApi.agents(orgId!),
    {
      ...SHELL_QUERY,
      // Shorter TTL than observe lists — status moves often — but still
      // respect staleTime so SSR / soft-nav stay cache-hit.
      staleTime: LIVE_STALE,
      refetchOnMount: true,
    },
  );
  const agents = agentsQuery.data ?? [];
  // BUG-7: the "Unattributed" card is a synthetic aggregate, not a real
  // agent — pull it out so it never competes for fleet-group placement,
  // selection, or rename/detail interactions meant for real agents.
  const unattributed =
    agents.find((a) => a.id === UNATTRIBUTED_AGENT_ID) ?? null;
  const realAgents = useMemo(
    () => agents.filter((a) => a.id !== UNATTRIBUTED_AGENT_ID),
    [agents],
  );
  const [fleetOpen, setFleetOpen, , fleetAnimate] = usePersistentBool(
    "eden.agents.fleetOpen",
    true,
  );
  /** Tailwind `lg` — below this, fleet list and detail are exclusive full-bleed panes. */
  const isLgUp = useMinWidth(1024);
  const [selectedId, setSelectedId] = useState(
    () => realAgents.find((a) => a.id === paramId)?.id ?? realAgents[0]?.id ?? "",
  );

  // Deep-link on phone → full-bleed detail (mq must be known false).
  useEffect(() => {
    if (isLgUp !== false) return;
    if (paramId) setFleetOpen(false);
  }, [isLgUp, paramId, setFleetOpen]);

  useEffect(() => {
    const next = realAgents.find((a) => a.id === paramId)?.id ?? realAgents[0]?.id;
    if (next && next !== selectedId) setSelectedId(next);
    else if (!next && selectedId) setSelectedId("");
  }, [paramId, realAgents]);

  const selectAgent = useCallback(
    (id: string) => {
      setSelectedId(id);
      patchQuery({ id });
      if (isLgUp === false) setFleetOpen(false);
    },
    [patchQuery, isLgUp, setFleetOpen],
  );

  const selected =
    realAgents.find((a) => a.id === selectedId) ?? realAgents[0] ?? null;

  const ordered = useMemo(() => {
    const rank = { error: 0, live: 1, idle: 2 } as const;
    return [...realAgents].sort((a, b) => {
      const byStatus = rank[a.status] - rank[b.status];
      if (byStatus !== 0) return byStatus;
      if (b.runs24h !== a.runs24h) return b.runs24h - a.runs24h;
      const aSeen = a.lastSeen || "";
      const bSeen = b.lastSeen || "";
      if (aSeen !== bSeen) return bSeen.localeCompare(aSeen);
      return a.name.localeCompare(b.name);
    });
  }, [realAgents]);

  const fleetGroups = useMemo(() => {
    const groups: {
      key: "error" | "live" | "idle";
      label: string;
      items: AgentFixture[];
    }[] = [
      { key: "error", label: "Needs attention", items: [] },
      { key: "live", label: "Active in last 24h", items: [] },
      { key: "idle", label: "Idle", items: [] },
    ];
    for (const agent of ordered) {
      const g = groups.find((x) => x.key === agent.status);
      g?.items.push(agent);
    }
    return groups.filter((g) => g.items.length > 0);
  }, [ordered]);

  const fleetIssues = realAgents.reduce((s, a) => s + a.openIssues, 0);
  const fleetRuns = realAgents.reduce((s, a) => s + a.runs24h, 0);
  const live = realAgents.filter((a) => a.status === "live").length;
  const errored = realAgents.filter((a) => a.status === "error").length;
  const knownSpend = realAgents
    .map((a) => a.costUsd24h)
    .filter((c): c is number => c != null && Number.isFinite(c));
  const fleetSpend =
    knownSpend.length > 0 ? knownSpend.reduce((s, c) => s + c, 0) : null;

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Agents"
        message="Select a workspace to view agents."
      />
    );
  }

  if (agentsQuery.isLoading) {
    return (
      <div className="ds-page">
        <PageHeader title="Agents" />
        <QueryLoadingPanel label="Loading agents…" />
      </div>
    );
  }

  if (agentsQuery.isError) {
    return (
      <div className="ds-page">
        <PageHeader title="Agents" />
        <QueryErrorPanel
          error={agentsQuery.error}
          onRetry={() => void agentsQuery.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="ds-page">
      <HelpInstallBar agentId={selectedId} />
      <PageHeader
        title="Agents"
        meta={
          <span className="type-meta hidden sm:inline">
            {realAgents.length} agents · {live} active · {errored} error ·{" "}
            {fleetIssues} issues · {fleetRuns} runs · {formatUsd(fleetSpend)}
          </span>
        }
        actions={
          !fleetOpen ? (
            <ListRevealButton label="Fleet" onClick={() => setFleetOpen(true)} />
          ) : undefined
        }
      />

      <div className="flex min-h-0 min-w-0 flex-1">
        <aside
          className={cn(
            "flex min-h-0 shrink-0 flex-col overflow-hidden border-[var(--line)]",
            fleetAnimate && "transition-[width,opacity] duration-200 ease-out",
            fleetOpen
              ? "w-full border-r opacity-100 lg:w-[16.5rem]"
              : "pointer-events-none w-0 border-r-0 opacity-0",
          )}
          aria-hidden={!fleetOpen}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-[var(--line)] px-3 py-2.5">
            <p className="type-label">Fleet</p>
            <button
              type="button"
              onClick={() => setFleetOpen(false)}
              className="ds-btn ds-btn-ghost ds-btn-icon hidden lg:inline-flex"
              aria-label="Collapse fleet list"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>
          {unattributed ? (
            // BUG-7: telemetry/issues whose events never got an
            // agent_id stamped are otherwise invisible in every card
            // above — surface the excluded volume instead of silently
            // dropping it. Not a real agent, so it's not a fleet-group
            // member or a clickable selection target.
            <div
              className="shrink-0 border-b border-[var(--line)] bg-[var(--bg-inset)] px-3 py-2.5"
              title="Traces and issues with no agent_id stamped on any event — excluded from every agent's numbers above."
            >
              <p className="type-ui truncate text-[var(--warning,var(--accent))]">
                Unattributed
              </p>
              <p className="type-meta mt-1 truncate">
                {unattributed.runs24h} runs
                {unattributed.openIssues > 0 ? (
                  <span className="text-[var(--error)]">
                    {" "}
                    · {unattributed.openIssues} issues
                  </span>
                ) : null}
                {" · "}
                {formatUsd(unattributed.costUsd24h)}
              </p>
            </div>
          ) : null}
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {ordered.length === 0 ? (
              <li className="px-3 py-5">
                <EmptyState
                  icon={Bot}
                  title="No agents yet"
                  body={U20_EMPTY_COPY.agents}
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link
                    href="/settings?mode=keys"
                    className="ds-btn ds-btn-primary ds-btn-sm"
                  >
                    API keys
                  </Link>
                </div>
              </li>
            ) : (
              fleetGroups.map((group) => (
                <li key={group.key}>
                  <p className="type-label sticky top-0 z-[1] border-b border-[var(--line)] bg-[var(--bg-inset)] px-3 py-1.5">
                    {group.label}
                  </p>
                  <ul>
                    {group.items.map((agent) => {
                      const active = agent.id === selected?.id;
                      return (
                        <li key={agent.id}>
                          <button
                            type="button"
                            onClick={() => selectAgent(agent.id)}
                            aria-label={`${agent.name}, ${agent.status}`}
                            className={cn(
                              "w-full border-b border-[var(--line)] px-3 py-2.5 text-left transition-colors",
                              active
                                ? "bg-[var(--accent-muted)]"
                                : "hover:bg-[var(--accent-muted)]",
                            )}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <p className="type-ui min-w-0 truncate">
                                {agent.name}
                              </p>
                              <span className="shrink-0">
                                <AgentStatusBadge status={agent.status} />
                              </span>
                            </div>
                            <p className="type-meta mt-1 truncate">
                              {agent.runs24h} runs
                              {agent.openIssues > 0 ? (
                                <span className="text-[var(--error)]">
                                  {" "}
                                  · {agent.openIssues} issues
                                </span>
                              ) : null}
                              {" · "}
                              {formatUsd(agent.costUsd24h)}
                            </p>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))
            )}
          </ul>
        </aside>

        <div
          className={cn(
            "min-h-0 min-w-0 flex-1",
            fleetOpen ? "hidden lg:block" : "block",
          )}
        >
          <AgentDetail
            agent={selected}
            onBackToList={() => setFleetOpen(true)}
          />
        </div>
      </div>
    </div>
  );
}

export default function LabAgentsPage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page">
          <PageHeader title="Agents" meta={<InlineLoading label="Loading agents" />} />
        </div>
      }
    >
      <LabAgentsInner />
    </Suspense>
  );
}
