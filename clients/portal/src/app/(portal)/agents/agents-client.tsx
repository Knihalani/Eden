"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { PanelLeftClose, ChevronLeft, ChevronRight, ExternalLink, Pencil, X } from "lucide-react";
import {
  tracesForAgent,
  type AgentFixture,
} from "@/lab/fixtures/agents";
import {
  formatDuration,
  formatTokens,
  formatUsd,
  sortTracesNewestFirst,
  type TraceFixture,
} from "@/lab/fixtures/traces";
import { PageHeader } from "@/components/ds/primitives";
import { useQueryPatch } from "@/lab/agent-scope";
import { useListKeyboard, usePersistentBool } from "@/lab/hooks";
import {
  AgentStatusBadge,
  EmptyState,
  errorStepIds,
  FilterChips,
  ListRevealButton,
  RunListButton,
  RunMeta,
  RunTranscript,
  SeverityBadge,
} from "@/lab/lab-ui";
import { MetricCell } from "@/lab/lab-metric-cell";
import { cn } from "@/lib/utils";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { SHELL_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { useLabToast } from "@/lab/lab-toast";

const ConnectRepoPanel = dynamic(
  () =>
    import("@/components/agents/ConnectRepoPanel").then((m) => ({
      default: m.ConnectRepoPanel,
    })),
  {
    ssr: false,
    loading: () => (
      <p className="type-meta px-1 py-4 text-[var(--text-faint)]">
        Loading connect panel…
      </p>
    ),
  },
);

type RunFilter = "all" | "error" | "warn" | "ok";

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
              {trace.id} · {trace.startedAt} · {agent.name}
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
              className="ds-btn ds-btn-primary ds-btn-sm"
            >
              Traces
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
          <EmptyState
            title="Loading transcript"
            body="Fetching spans for this run…"
            compact
          />
        ) : !stepsLoading && trace.steps.length === 0 ? (
          <EmptyState
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
          />
        )}
      </div>
    </div>
  );
}

function AgentDetail({ agent }: { agent: AgentFixture | null }) {
  if (!agent) {
    return (
      <div className="space-y-4 p-5">
        <EmptyState
          title="No agents yet"
          body="Send traffic with the SDK using an agent_id (or project id). Agents appear here automatically from traces — connect a GitHub repo later from an agent’s detail view when you want Improve to open fix PRs."
        />
        <div className="flex flex-wrap gap-2">
          <Link href="/settings?mode=keys" className="ds-btn ds-btn-primary ds-btn-sm">
            API keys
          </Link>
          <Link href="/gateway" className="ds-btn ds-btn-outline ds-btn-sm">
            Gateway usage
          </Link>
          <Link href="/traces" className="ds-btn ds-btn-ghost ds-btn-sm">
            Traces
          </Link>
        </div>
      </div>
    );
  }

  return <AgentDetailBody agent={agent} />;
}

function AgentDetailBody({ agent }: { agent: AgentFixture }) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const queryClient = useQueryClient();
  const { pushToast } = useLabToast();
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

  // Prefer React Query traces for this page — catalog alone was empty
  // when /agents did not prefetch traces (runs24h showed N, list showed 0).
  const tracesQuery = useOrgQuery(
    queryKeys.portal.traces(orgId),
    orgId,
    () => portalApi.traces(orgId!),
    SHELL_QUERY,
  );
  const runs = useMemo(() => {
    const fromApi = (tracesQuery.data ?? []).filter(
      (t) => t.agentId === agent.id,
    );
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
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
    () => portalApi.traceDetail(orgId!, selectedRunIdForDetail),
    {
      ...SHELL_QUERY,
      staleTime: 30_000,
      refetchOnMount: "always",
      enabled: Boolean(orgId) && Boolean(selectedRunIdForDetail),
    },
  );

  // List rows ship steps: [] — hydrate the selected run like traces-client.
  const selected = useMemo(() => {
    const detail = traceDetailQuery.data;
    if (detail && detail.id === selectedRunIdForDetail) {
      const base = selectedListItem ?? detail;
      const stepCost = Array.isArray(detail.steps)
        ? detail.steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0)
        : 0;
      const costUsd = Math.max(detail.costUsd ?? 0, base.costUsd ?? 0, stepCost);
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
      <header className="shrink-0 border-b border-[var(--line)] px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
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
              Agent id · <span className="font-mono">{agent.id}</span>
              {agent.purpose ? <> · {agent.purpose}</> : null}
            </p>
            <p className="type-meta">
              {agent.model ? <>{agent.model} · </> : null}
              {agent.lastSeen
                ? <>last telemetry {agent.lastSeen}</>
                : <>no recent activity in this window</>}
              {agent.topError ? (
                <>
                  {" · "}
                  <span className="text-[var(--error)]">{agent.topError}</span>
                </>
              ) : null}
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap gap-2">
            <Link
              href={`/agent?thread=thr_empty&agent=${agent.id}`}
              className="ds-btn ds-btn-ghost ds-btn-sm"
            >
              Ask AI
            </Link>
            <Link
              href={`/debugger?agent=${agent.id}`}
              className="ds-btn ds-btn-ghost ds-btn-sm"
            >
              Debugger
            </Link>
            <Link
              href={`/cost?agent=${agent.id}`}
              className="ds-btn ds-btn-ghost ds-btn-sm"
            >
              Cost
            </Link>
            <Link
              href={`/improve?agent=${agent.id}`}
              className="ds-btn ds-btn-ghost ds-btn-sm"
            >
              Improve
            </Link>
            <Link
              href={`/signals?agent=${agent.id}`}
              className="ds-btn ds-btn-ghost ds-btn-sm"
            >
              Signals
            </Link>
            <Link
              href={`/issues?agent=${agent.id}`}
              className="ds-btn ds-btn-ghost ds-btn-sm"
            >
              Issues
              {agent.openIssues > 0 ? ` · ${agent.openIssues}` : ""}
            </Link>
            <Link
              href={`/agents/connect?agent=${encodeURIComponent(agent.id)}`}
              className="ds-btn ds-btn-outline ds-btn-sm"
            >
              Connect repo
            </Link>
            <Link
              href={`/traces?agent=${agent.id}`}
              className="ds-btn ds-btn-primary ds-btn-sm"
            >
              Traces
            </Link>
          </div>
        </div>
      </header>

      <div className="border-b border-[var(--line)] px-4 py-4 sm:px-5">
        <ConnectRepoPanel agentId={agent.id} compact />
      </div>

      <div className="lab-metric-strip shrink-0">
        <MetricCell label="Runs (24h)" value={String(agent.runs24h)} />
        <MetricCell
          label="Success"
          value={
            agent.runs24h > 0
              ? `${(agent.successRate * 100).toFixed(0)}%`
              : "—"
          }
          hint={
            agent.runs24h > 0
              ? `${(agent.errorRate * 100).toFixed(0)}% errors`
              : "no runs in window"
          }
          tone={
            agent.runs24h <= 0
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
          value={formatDuration(agent.p50Ms)}
          hint={formatDuration(agent.p95Ms)}
        />
        <MetricCell
          label="Spend"
          value={formatUsd(agent.costUsd24h)}
          hint={`${formatTokens(agent.tokens24h)} · ${formatUsd(agent.costUsd24h / Math.max(agent.runs24h, 1), 3)}/run`}
        />
        <MetricCell
          label="Issues"
          value={String(agent.openIssues)}
          tone={agent.openIssues > 0 ? "error" : "default"}
          hint={`${failures.length} fail · ${warnings.length} warn in list`}
        />
      </div>

      <div className="grid min-h-0 min-w-0 flex-1 lg:grid-cols-[minmax(15rem,22rem)_minmax(0,1fr)]">
        <section className="flex min-h-0 min-w-0 flex-col border-b border-[var(--line)] lg:border-b-0 lg:border-r">
          <div className="lab-list-chrome">
            <div className="flex items-center justify-between gap-2">
              <p className="type-ui text-[var(--text)]">Runs</p>
              <span className="type-mono">
                {selectedIndex >= 0 ? selectedIndex + 1 : 0}/{filtered.length}
              </span>
            </div>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="ds-input w-full"
              aria-label="Filter runs"
            />
            <FilterChips
              value={runFilter}
              onChange={setRunFilter}
              scroll
              options={[
                { id: "all", label: "All", count: runs.length },
                { id: "error", label: "Fail", count: failures.length },
                { id: "warn", label: "Warn", count: warnings.length },
                {
                  id: "ok",
                  label: "Ok",
                  count: runs.filter((t) => t.severity === "none").length,
                },
              ]}
            />
          </div>

          <ul className="min-h-0 flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <li>
                <EmptyState title="No matching runs" />
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
            <EmptyState title="Select a run" />
          )}
        </section>
      </div>
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
    SHELL_QUERY,
  );
  const agents = agentsQuery.data ?? [];
  const [fleetOpen, setFleetOpen, , fleetAnimate] = usePersistentBool(
    "eden.agents.fleetOpen",
    true,
  );
  const [selectedId, setSelectedId] = useState(
    () => agents.find((a) => a.id === paramId)?.id ?? agents[0]?.id ?? "",
  );

  useEffect(() => {
    const next = agents.find((a) => a.id === paramId)?.id ?? agents[0]?.id;
    if (next && next !== selectedId) setSelectedId(next);
    else if (!next && selectedId) setSelectedId("");
  }, [paramId, agents]);

  const selectAgent = useCallback(
    (id: string) => {
      setSelectedId(id);
      patchQuery({ id });
    },
    [patchQuery],
  );

  const selected =
    agents.find((a) => a.id === selectedId) ?? agents[0] ?? null;

  const ordered = useMemo(() => {
    const rank = { error: 0, live: 1, idle: 2 } as const;
    return [...agents].sort((a, b) => {
      const byStatus = rank[a.status] - rank[b.status];
      if (byStatus !== 0) return byStatus;
      if (b.runs24h !== a.runs24h) return b.runs24h - a.runs24h;
      const aSeen = a.lastSeen || "";
      const bSeen = b.lastSeen || "";
      if (aSeen !== bSeen) return bSeen.localeCompare(aSeen);
      return a.name.localeCompare(b.name);
    });
  }, [agents]);

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

  const fleetIssues = agents.reduce((s, a) => s + a.openIssues, 0);
  const fleetRuns = agents.reduce((s, a) => s + a.runs24h, 0);
  const live = agents.filter((a) => a.status === "live").length;
  const errored = agents.filter((a) => a.status === "error").length;
  const fleetSpend = agents.reduce((s, a) => s + a.costUsd24h, 0);

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
      <PageHeader
        title="Agents"
        meta={
          <span className="type-meta hidden sm:inline">
            {agents.length} agents · {live} active · {errored} error ·{" "}
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
              ? "w-[16.5rem] border-r opacity-100 lg:w-[19rem]"
              : "pointer-events-none w-0 border-r-0 opacity-0",
          )}
          aria-hidden={!fleetOpen}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-[var(--line)] px-4 py-3">
            <p className="type-label">Fleet</p>
            <button
              type="button"
              onClick={() => setFleetOpen(false)}
              className="ds-btn ds-btn-ghost ds-btn-icon"
              aria-label="Collapse fleet list"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {ordered.length === 0 ? (
              <li className="px-4 py-6">
                <p className="type-meta text-[var(--text-secondary)]">
                  No agents yet
                </p>
              </li>
            ) : (
              fleetGroups.map((group) => (
                <li key={group.key}>
                  <p className="type-label sticky top-0 z-[1] border-b border-[var(--line)] bg-[var(--bg-inset)] px-4 py-2">
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
                            className={cn(
                              "w-full border-b border-[var(--line)] px-4 py-3.5 text-left transition-colors",
                              active
                                ? "bg-[var(--accent-muted)]"
                                : "hover:bg-[var(--accent-muted)]",
                            )}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <p className="type-ui min-w-0 truncate">
                                {agent.name}
                              </p>
                              <AgentStatusBadge status={agent.status} />
                            </div>
                            {agent.id !== agent.name ? (
                              <p className="type-meta mt-0.5 truncate text-[var(--text-tertiary)]">
                                id · {agent.id}
                              </p>
                            ) : (
                              <p className="type-meta mt-0.5 truncate text-[var(--text-tertiary)]">
                                Rename to give this a clearer label
                              </p>
                            )}
                            <p className="type-meta mt-1.5">
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
                            {agent.purpose ? (
                              <p className="type-meta mt-1 truncate text-[var(--text-tertiary)]">
                                {agent.purpose}
                              </p>
                            ) : null}
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

        <AgentDetail agent={selected} />
      </div>
    </div>
  );
}

export default function LabAgentsPage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page">
          <PageHeader title="Agents" meta={<span className="type-meta">Loading…</span>} />
        </div>
      }
    >
      <LabAgentsInner />
    </Suspense>
  );
}
