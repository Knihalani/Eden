"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  agentForTrace,
  homeSnapshot,
  type AgentFixture,
} from "@/lab/fixtures/agents";
import { issueForTrace, type IssueFixture } from "@/lab/fixtures/issues";
import {
  formatDuration,
  formatUsd,
  type TraceFixture,
} from "@/lab/fixtures/traces";
import { formatRelativeTime } from "@/lib/format";
import { PageHeader } from "@/components/ds/primitives";
import { useDismissedSet } from "@/lab/hooks";
import { useAlerts } from "@/lab/alerts-context";
import {
  AgentLink,
  AgentStatusBadge,
  EmptyState,
  RunMeta,
  SeverityBadge,
} from "@/lab/lab-ui-home";
import { cn } from "@/lib/utils";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { SHELL_QUERY, OBSERVE_STALE } from "@/lib/portal-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { wave6Api } from "@/lib/api/resources";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { FirstEventWaitAction } from "@/components/shell/first-event-wait";
import { FIRST_EVENT_WAIT, U20_EMPTY_COPY } from "@/lib/portal-polish";
import { getPageDescription } from "@/lib/page-descriptions";
import { AutonomyRoiBanner } from "@/lab/autonomy-roi-banner";

function Kpi({
  label,
  value,
  hint,
  tone = "default",
  hintTone = "default",
  href,
  className,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "default" | "error" | "ok" | "live";
  hintTone?: "default" | "error" | "ok";
  href: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      aria-label={`${label}: ${value}. ${hint}`}
      className={cn(
        "min-w-0 flex-1 basis-[8rem] border-b border-[var(--line)] px-5 py-5 transition-colors hover:bg-[var(--accent-muted)] sm:border-b-0 sm:border-r sm:last:border-r-0",
        className,
      )}
    >
      <p className="type-label">{label}</p>
      <p
        className={cn(
          "type-display mt-1.5 !text-[1.5rem] tabular-nums",
          tone === "error" && "text-[var(--error)]",
          tone === "ok" && "text-[var(--success)]",
          tone === "live" && "text-[var(--status-running)]",
          tone === "default" && "text-[var(--text)]",
        )}
      >
        {value}
      </p>
      <p
        className={cn(
          "type-meta mt-1 truncate",
          hintTone === "error" && "text-[var(--error)]",
          hintTone === "ok" && "text-[var(--success)]",
        )}
      >
        {hint}
      </p>
    </Link>
  );
}

function AttentionCard({
  trace,
  issue,
  onDismiss,
}: {
  trace: TraceFixture;
  issue: IssueFixture | undefined;
  onDismiss: () => void;
}) {
  const agent = agentForTrace(trace);
  const isError = trace.severity === "error";
  const agentName = agent?.name ?? trace.agentId;
  const agentId = agent?.id ?? trace.agentId;

  return (
    <li
      className={cn(
        "border-b border-[var(--line)] last:border-b-0",
        isError && "bg-[var(--error-muted)]",
        trace.severity === "warn" && "bg-[var(--error-muted)]",
      )}
    >
      <div className="px-5 py-5 sm:px-6">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityBadge severity={trace.severity} />
              <p className="type-ui text-[var(--text)]">{trace.signals.title}</p>
            </div>
            <p className="type-meta mt-2">
              <AgentLink agentId={agentId} name={agentName} />
              {" · "}
              {trace.name}
              {" · "}
              {formatRelativeTime(trace.startedAt)}
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="ds-btn ds-btn-ghost ds-btn-icon shrink-0"
            aria-label="Dismiss"
            title="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <p className="type-body mt-3.5 max-w-2xl text-[var(--text-secondary)]">
          {trace.signals.body}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <RunMeta trace={trace} />
          <span className="flex-1" />
          {issue ? (
            <Link
              href={`/issues?id=${issue.id}&agent=${issue.agentId}`}
              className="ds-btn ds-btn-primary ds-btn-sm"
            >
              Issue
            </Link>
          ) : (
            <Link
              href={`/traces?id=${trace.id}&tab=signals&agent=${agentId}`}
              className="ds-btn ds-btn-primary ds-btn-sm"
            >
              Run
            </Link>
          )}
          {issue ? (
            <Link
              href={`/traces?id=${trace.id}&tab=signals&agent=${agentId}`}
              className="ds-btn ds-btn-ghost ds-btn-sm"
            >
              Run
            </Link>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export default function HomeClient() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const [showAllFleet, setShowAllFleet] = useState(false);
  const [showMetrics, setShowMetrics] = useState(false);
  const [showFleet, setShowFleet] = useState(false);

  /**
   * Attention path first: traces + issues. Fleet/agents wait until
   * "Show fleet" so cold Home does not race three LIVE GETs.
   */
  const tracesQuery = useOrgQuery(
    queryKeys.portal.traces(orgId),
    orgId,
    () => portalApi.traces(orgId!),
    SHELL_QUERY,
  );
  /**
   * Subscribed here (not just read from the ``portal-catalog``
   * singleton via ``issueForTrace``) so Home re-renders the moment
   * ``PortalCatalogSync``'s issues GET resolves — the singleton is
   * patched on a delayed ``useEffect`` in a sibling component, which
   * doesn't by itself trigger a re-render of this page.
   */
  const issuesQuery = useOrgQuery(
    queryKeys.portal.issues(orgId),
    orgId,
    () => portalApi.issues(orgId!),
    {
      ...SHELL_QUERY,
      enabled: Boolean(orgId),
    },
  );
  const agentsQuery = useOrgQuery(
    queryKeys.portal.agents(orgId),
    orgId,
    () => portalApi.agents(orgId!),
    {
      ...SHELL_QUERY,
      staleTime: OBSERVE_STALE,
      enabled: Boolean(orgId) && showFleet,
    },
  );

  const costKpiQuery = useOrgQuery(
    ["portal", "costKpi", orgId, 24] as const,
    orgId,
    async () => {
      const res = await wave6Api.costKpi(orgId!, { window_hours: 24 });
      return res.data;
    },
    SHELL_QUERY,
  );

  const agentsLoaded = agentsQuery.data !== undefined;
  const agents = agentsQuery.data ?? [];
  const traces = tracesQuery.data ?? [];
  const zeroData = traces.length === 0;

  // Soft-poll while waiting for first ingest so Home updates without a full reload.
  useEffect(() => {
    if (!orgId || !zeroData) return;
    const id = window.setInterval(() => {
      void tracesQuery.refetch();
    }, FIRST_EVENT_WAIT.pollMs);
    return () => window.clearInterval(id);
    // tracesQuery identity is unstable; refetch via orgId + zeroData only.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [orgId, zeroData]);

  /** Map traceId -> open (or most-recent) issue, built from the live
   * issues query so Run/Issue badges react to ``issues.data`` instead
   * of only the module-level catalog singleton. */
  const issueByTraceId = useMemo(() => {
    const map = new Map<string, IssueFixture>();
    for (const issue of issuesQuery.data ?? []) {
      for (const traceId of issue.occurrenceTraceIds) {
        const existing = map.get(traceId);
        if (!existing || (existing.status === "resolved" && issue.status !== "resolved")) {
          map.set(traceId, issue);
        }
      }
    }
    return map;
  }, [issuesQuery.data]);

  const openIssuesCount = useMemo(
    () =>
      (issuesQuery.data ?? []).filter((i) => i.status !== "resolved").length,
    [issuesQuery.data],
  );

  const resolveIssueForTrace = (traceId: string): IssueFixture | undefined =>
    issueByTraceId.get(traceId) ?? issueForTrace(traceId);

  const snap = useMemo(
    () => homeSnapshot(agents, traces),
    [agents, traces],
  );

    const liveTiles = useMemo(() => {
    const payload = costKpiQuery.data as
      | {
          tiles?: Array<Record<string, unknown>>;
          data_source?: string;
        }
      | undefined;
    const tiles = payload?.tiles ?? [];
    const byKey = (key: string) =>
      tiles.find((t) => t.key === key) as
        | { value?: number; previous?: number; delta_pct?: number | null }
        | undefined;
    return {
      cost: byKey("cost_usd"),
      traces: byKey("traces"),
      cacheSavings: byKey("cache_savings_usd"),
      source: payload?.data_source,
      ready: costKpiQuery.data !== undefined && !costKpiQuery.isError,
    };
  }, [costKpiQuery.data, costKpiQuery.isError]);

  const alerts = useDismissedSet("eden.home.dismissedAlerts");
  const { openAlerts } = useAlerts();

  const visibleAlerts = useMemo(
    () => snap.attention.filter((t) => !alerts.dismissed.has(t.id)),
    [snap.attention, alerts.dismissed],
  );

  const dismissedCount = snap.attention.length - visibleAlerts.length;
  const attentionFails = visibleAlerts.filter((t) => t.severity === "error").length;
  const attentionWarns = visibleAlerts.filter((t) => t.severity === "warn").length;

  const orderedFleet = useMemo(
    () =>
      [...agents].sort((a: AgentFixture, b: AgentFixture) => {
        const rank = { error: 0, live: 1, idle: 2 } as const;
        const byStatus = rank[a.status] - rank[b.status];
        if (byStatus !== 0) return byStatus;
        if (b.runs24h !== a.runs24h) return b.runs24h - a.runs24h;
        return a.name.localeCompare(b.name);
      }),
    [agents],
  );
  const fleet = showAllFleet ? orderedFleet : orderedFleet.slice(0, 3);
  const recent = snap.recent.slice(0, 4);

  // First paint gates on attention shards only — fleet can stream in later.
  const isLoading = tracesQuery.isLoading;
  const isError = tracesQuery.isError;

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Home"
        message="Select a workspace to view your home overview."
      />
    );
  }

  if (isLoading) {
    return (
      <div className="ds-page overflow-y-auto">
        <PageHeader title="Home" />
        <QueryLoadingPanel label="Loading home…" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="ds-page overflow-y-auto">
        <PageHeader title="Home" />
        <QueryErrorPanel
          error={tracesQuery.error}
          onRetry={() => {
            void tracesQuery.refetch();
            void issuesQuery.refetch();
          }}
        />
      </div>
    );
  }

  return (
    <div className="ds-page overflow-y-auto">
      <PageHeader
        title="Home"
        meta={
          <span className="type-meta max-w-xl truncate">
            {getPageDescription("/home")}
          </span>
        }
      />

      <AutonomyRoiBanner />

      {/* First viewport: KPIs — live cost/traces when available */}
      <div className="flex flex-wrap border-b border-[var(--line)]">
        <Kpi
          label="Failures"
          value={String(snap.failures.length)}
          hint={`${openIssuesCount} open issues`}
          tone={snap.failures.length ? "error" : "default"}
          hintTone={openIssuesCount > 0 ? "error" : "default"}
          href={zeroData ? "/traces" : "/issues"}
        />
        <Kpi
          label="Traces"
          value={
            liveTiles.ready && liveTiles.traces?.value != null
              ? String(Math.round(Number(liveTiles.traces.value)))
              : traces.length
                ? String(traces.length)
                : "—"
          }
          hint={
            liveTiles.ready
              ? liveTiles.source === "clickhouse"
                ? "24h · analytics"
                : "24h · live"
              : traces.length
                ? "from feed"
                : "no runs yet"
          }
          tone="default"
          href="/traces"
        />
        <Kpi
          label="Agents"
          value={agentsLoaded ? String(snap.agents) : "—"}
          hint={
            agentsLoaded
              ? snap.errored
                ? `${snap.errored} in error`
                : snap.live
                  ? `${snap.live} active in 24h`
                  : "none active in 24h"
              : "Open fleet"
          }
          tone="default"
          hintTone={agentsLoaded && snap.errored ? "error" : "default"}
          href="/agents"
        />
        <Kpi
          label="Spend"
          value={
            liveTiles.ready && liveTiles.cost?.value != null
              ? formatUsd(Number(liveTiles.cost.value))
              : "—"
          }
          tone="default"
          hint={
            liveTiles.ready && liveTiles.cost?.delta_pct != null
              ? `${liveTiles.cost.delta_pct > 0 ? "+" : ""}${liveTiles.cost.delta_pct}% vs prior`
              : liveTiles.cacheSavings?.value
                ? `${formatUsd(Number(liveTiles.cacheSavings.value))} cached`
                : "24h"
          }
          hintTone={
            liveTiles.cost?.delta_pct != null && liveTiles.cost.delta_pct > 20
              ? "error"
              : "default"
          }
          href="/cost"
          className="hidden sm:block"
        />
      </div>

      <section className="border-b border-[var(--line)]">
        <header className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-3.5 sm:px-6">
          <div>
            <h2 className="type-ui text-[var(--text)]">Needs attention</h2>
            {visibleAlerts.length > 0 ? (
              <p className="type-meta mt-1">
                {attentionFails} fail · {attentionWarns} warn
              </p>
            ) : (
              <p className="type-meta mt-1">
                {zeroData
                  ? "Create a key, run doctor, then open Traces"
                  : "No failing runs in view"}
              </p>
            )}
          </div>
          {visibleAlerts.length > 1 ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              onClick={() =>
                alerts.dismissMany(visibleAlerts.map((t) => t.id))
              }
            >
              Dismiss all
            </button>
          ) : null}
        </header>

        {visibleAlerts.length === 0 ? (
          <EmptyState
            title={zeroData ? FIRST_EVENT_WAIT.title : "All clear"}
            body={
              zeroData
                ? FIRST_EVENT_WAIT.description
                : dismissedCount > 0
                  ? `${dismissedCount} dismissed. ${U20_EMPTY_COPY.alertsClear}`
                  : U20_EMPTY_COPY.alertsClear
            }
            action={
              zeroData ? (
                <FirstEventWaitAction
                  onCheck={() => {
                    void tracesQuery.refetch();
                  }}
                  checking={tracesQuery.isFetching}
                />
              ) : dismissedCount > 0 ? (
                <button
                  type="button"
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                  onClick={() => alerts.restore()}
                >
                  Restore
                </button>
              ) : undefined
            }
          />
        ) : (
          <ul>
            {visibleAlerts.slice(0, 3).map((trace) => (
              <AttentionCard
                key={trace.id}
                trace={trace}
                issue={resolveIssueForTrace(trace.id)}
                onDismiss={() => alerts.dismiss(trace.id)}
              />
            ))}
          </ul>
        )}
      </section>

      <div
        className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-5 py-4 sm:px-6"
        role="group"
        aria-label="Primary actions"
      >
        {zeroData ? (
          <>
            <Link
              href="/settings?mode=keys"
              className="ds-btn ds-btn-primary ds-btn-sm"
            >
              Create API key
            </Link>
            <Link href="/traces" className="ds-btn ds-btn-outline ds-btn-sm">
              Traces
            </Link>
            <Link href="/issues" className="ds-btn ds-btn-ghost ds-btn-sm">
              Issues
            </Link>
          </>
        ) : (
          <>
            <Link href="/issues" className="ds-btn ds-btn-primary ds-btn-sm">
              Issues
            </Link>
            <Link href="/traces" className="ds-btn ds-btn-outline ds-btn-sm">
              Traces
            </Link>
            <Link
              href="/settings?mode=keys"
              className="ds-btn ds-btn-outline ds-btn-sm"
            >
              API keys
            </Link>
          </>
        )}
        <span className="flex-1" />
        <button
          type="button"
          className="ds-btn ds-btn-ghost ds-btn-sm"
          onClick={openAlerts}
          aria-label="Open Inbox"
          title="Inbox"
        >
          Inbox
        </button>
      </div>

      {/* Below fold / disclosure — fleet + recent */}
      <div className="border-b border-[var(--line)] px-5 py-3 sm:px-6">
        <button
          type="button"
          className="ds-btn ds-btn-ghost ds-btn-sm"
          onClick={() => setShowFleet((v) => !v)}
          aria-expanded={showFleet}
        >
          {showFleet ? "Hide fleet" : "Show fleet"}
        </button>
      </div>

      {showFleet ? (
        agentsQuery.isLoading && !agentsLoaded ? (
          <QueryLoadingPanel label="Loading fleet…" />
        ) : (
        <div className="grid min-h-0 lg:grid-cols-[minmax(0,1.4fr)_minmax(16rem,0.75fr)]">
          <div className="min-w-0 border-b border-[var(--line)] lg:border-b-0 lg:border-r">
            <section>
              <header className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-3.5 sm:px-6">
                <h2 className="type-ui text-[var(--text)]">Recent runs</h2>
                <Link
                  href="/traces"
                  className="type-meta text-[var(--accent)]"
                >
                  Traces
                </Link>
              </header>
              {recent.length === 0 ? (
                <EmptyState
                  title="No recent runs"
                  body={U20_EMPTY_COPY.dashboardTraces}
                  action={
                    <Link
                      href="/traces"
                      className="ds-btn ds-btn-ghost ds-btn-sm"
                    >
                      Open traces
                    </Link>
                  }
                />
              ) : (
                <ul>
                  {recent.map((trace) => {
                    const agent = agentForTrace(trace);
                    return (
                      <li key={trace.id}>
                        <Link
                          href={`/traces?id=${trace.id}${agent ? `&agent=${agent.id}` : ""}${trace.severity !== "none" ? "&tab=signals" : ""}`}
                          className="lab-run-row"
                          data-severity={trace.severity}
                        >
                          <SeverityBadge severity={trace.severity} />
                          <div className="min-w-0 flex-1">
                            <p className="type-ui truncate text-[var(--text)]">
                              {trace.name}
                            </p>
                            <p className="type-meta mt-1 truncate">
                              {agent?.name ?? "—"} ·{" "}
                              {formatRelativeTime(trace.startedAt)}
                            </p>
                          </div>
                          <span className="type-value shrink-0 tabular-nums !text-[0.6875rem]">
                            {formatDuration(trace.durationMs)}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>

          <aside className="min-w-0">
            <header className="flex items-center justify-between border-b border-[var(--line)] px-5 py-3.5 sm:px-6">
              <h2 className="type-ui text-[var(--text)]">Fleet</h2>
              <Link href="/agents" className="type-meta text-[var(--accent)]">
                Agents
              </Link>
            </header>
            {fleet.length === 0 ? (
              <EmptyState
                title="No agents yet"
                body={U20_EMPTY_COPY.agents}
                action={
                  <Link href="/agents" className="ds-btn ds-btn-ghost ds-btn-sm">
                    Open agents
                  </Link>
                }
              />
            ) : (
              <ul>
                {fleet.map((agent) => (
                  <li key={agent.id} className="border-b border-[var(--line)]">
                    <Link
                      href={`/agents?id=${agent.id}`}
                      aria-label={`${agent.name}, ${agent.status}`}
                      className="block px-5 py-4 transition-colors hover:bg-[var(--accent-muted)] sm:px-6"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="type-mono min-w-0 truncate !text-[var(--text)]">
                          {agent.name}
                        </p>
                        <span className="shrink-0">
                          <AgentStatusBadge status={agent.status} />
                        </span>
                      </div>
                      {agent.id === agent.name ? (
                        <p className="type-meta mt-0.5 text-[var(--text-tertiary)]">
                          Rename on Agents for a clearer label
                        </p>
                      ) : null}
                      <p className="type-meta mt-1.5">
                        {agent.runs24h} runs
                        {agent.runs24h > 0 && agent.successRate != null ? (
                          <>
                            {" · "}
                            <span
                              className={
                                agent.successRate >= 0.95
                                  ? "text-[var(--success)]"
                                  : agent.successRate < 0.8
                                    ? "text-[var(--error)]"
                                    : undefined
                              }
                            >
                              {(agent.successRate * 100).toFixed(0)}%
                            </span>
                          </>
                        ) : agent.runs24h > 0 ? (
                          <> · success unknown</>
                        ) : (
                          <> · no runs</>
                        )}
                        {agent.openIssues > 0 ? (
                          <span className="text-[var(--error)]">
                            {" "}
                            · {agent.openIssues} issues
                          </span>
                        ) : null}
                        {" · "}
                        {formatUsd(agent.costUsd24h)}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}

            <div className="space-y-2 px-5 py-4 sm:px-6">
              {orderedFleet.length > 3 ? (
                <button
                  type="button"
                  className="ds-btn ds-btn-ghost ds-btn-sm w-full"
                  onClick={() => setShowAllFleet((v) => !v)}
                >
                  {showAllFleet ? "Show fewer" : "Show all"}
                </button>
              ) : null}
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-sm w-full"
                onClick={() => setShowMetrics((v) => !v)}
                aria-expanded={showMetrics}
              >
                {showMetrics ? "Hide metrics" : "Metrics"}
              </button>
              {showMetrics ? (
                <dl className="space-y-2.5 border-t border-[var(--line)] pt-4">
                  {[
                    { label: "p50 latency", value: formatDuration(snap.p50Ms) },
                    { label: "p95 latency", value: formatDuration(snap.p95Ms) },
                    {
                      label: "Avg cost / run",
                      value: formatUsd(snap.avgCostPerRun, 3),
                    },
                    {
                      label: "Error rate",
                      value:
                        snap.errorRate == null
                          ? "—"
                          : `${(snap.errorRate * 100).toFixed(0)}%`,
                    },
                    {
                      label: "Warnings",
                      value: String(snap.warnings.length),
                    },
                  ].map((row) => (
                    <div key={row.label} className="flex justify-between gap-3">
                      <dt className="type-meta">{row.label}</dt>
                      <dd className="type-mono !text-[var(--text)]">
                        {row.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>
          </aside>
        </div>
        )
      ) : null}
    </div>
  );
}
