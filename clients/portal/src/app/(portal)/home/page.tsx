"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  agentForTrace,
  homeSnapshot,
  type AgentFixture,
} from "@/lab/fixtures/agents";
import {
  budgetIsPressure,
  budgetStatusFromSpend,
  budgetStatusLabel,
} from "@/lab/home-budget";
import { issueForTrace } from "@/lab/fixtures/issues";
import {
  formatDuration,
  formatTokens,
  formatUsd,
  type TraceFixture,
} from "@/lab/fixtures/traces";
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
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";

function Kpi({
  label,
  value,
  hint,
  tone = "default",
  hintTone = "default",
  href,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "default" | "error" | "ok" | "live";
  hintTone?: "default" | "error" | "ok";
  href: string;
}) {
  return (
    <Link
      href={href}
      className="min-w-0 flex-1 basis-[8rem] border-b border-[var(--line)] px-5 py-5 transition-colors hover:bg-[var(--accent-muted)] sm:border-b-0 sm:border-r sm:last:border-r-0"
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
  onDismiss,
}: {
  trace: TraceFixture;
  onDismiss: () => void;
}) {
  const agent = agentForTrace(trace);
  const issue = issueForTrace(trace.id);
  const isError = trace.severity === "error";

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
              <AgentLink agentId={agent?.id} name={agent?.name ?? "unknown"} />
              {" · "}
              {trace.name}
              {" · "}
              {trace.startedAt}
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
              href={`/traces?id=${trace.id}&tab=signals${agent ? `&agent=${agent.id}` : ""}`}
              className="ds-btn ds-btn-primary ds-btn-sm"
            >
              Run
            </Link>
          )}
          {issue ? (
            <Link
              href={`/traces?id=${trace.id}&tab=signals${agent ? `&agent=${agent.id}` : ""}`}
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

export default function LabHomePage() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;

  const agentsQuery = useOrgQuery(
    queryKeys.portal.agents(orgId),
    orgId,
    () => portalApi.agents(orgId!),
  );
  const tracesQuery = useOrgQuery(
    queryKeys.portal.traces(orgId),
    orgId,
    () => portalApi.traces(orgId!),
  );

  const agents = agentsQuery.data ?? [];
  const traces = tracesQuery.data ?? [];

  const snap = useMemo(
    () => homeSnapshot(agents, traces),
    [agents, traces],
  );
  const alerts = useDismissedSet("eden.home.dismissedAlerts");
  const { openAlerts } = useAlerts();
  const [showAllFleet, setShowAllFleet] = useState(false);
  const [showMetrics, setShowMetrics] = useState(false);

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
        return rank[a.status] - rank[b.status];
      }),
    [agents],
  );
  const fleet = showAllFleet ? orderedFleet : orderedFleet.slice(0, 3);
  const recent = snap.recent.slice(0, 4);

  const fleetCostUsd = snap.fleetCost;
  const budgetStatus = budgetStatusFromSpend(fleetCostUsd, 0);

  const isLoading = agentsQuery.isLoading || tracesQuery.isLoading;
  const isError = agentsQuery.isError || tracesQuery.isError;

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
          error={agentsQuery.error ?? tracesQuery.error}
          onRetry={() => {
            void agentsQuery.refetch();
            void tracesQuery.refetch();
          }}
        />
      </div>
    );
  }

  return (
    <div className="ds-page overflow-y-auto">
      <PageHeader title="Home" />

      <div className="flex flex-wrap border-b border-[var(--line)]">
        <Kpi
          label="Failures"
          value={String(snap.failures.length)}
          hint={`${snap.openIssues} open issues`}
          tone={snap.failures.length ? "error" : "default"}
          hintTone={snap.openIssues > 0 ? "error" : "default"}
          href="/issues"
        />
        <Kpi
          label="Runs"
          value={String(snap.fleetRuns)}
          hint={`${(snap.successRate * 100).toFixed(0)}% success`}
          tone="default"
          hintTone={
            snap.successRate >= 0.95
              ? "ok"
              : snap.successRate < 0.8
                ? "error"
                : "default"
          }
          href="/traces"
        />
        <Kpi
          label="Agents"
          value={`${snap.live} live`}
          hint={
            snap.errored
              ? `${snap.errored} in error`
              : `${snap.agents} registered`
          }
          tone="default"
          hintTone={snap.errored ? "error" : "default"}
          href="/agents"
        />
        <Kpi
          label="Spend"
          value={formatUsd(snap.fleetCost)}
          tone={budgetIsPressure(budgetStatus) ? "error" : "default"}
          hint={
            budgetIsPressure(budgetStatus)
              ? `${budgetStatusLabel(budgetStatus)} · ${formatTokens(snap.fleetTokens)}`
              : formatTokens(snap.fleetTokens)
          }
          href={
            budgetIsPressure(budgetStatus)
              ? "/cost?mode=drivers"
              : "/cost"
          }
        />
      </div>

      <div className="grid min-h-0 lg:grid-cols-[minmax(0,1.4fr)_minmax(16rem,0.75fr)]">
        <div className="min-w-0 border-b border-[var(--line)] lg:border-b-0 lg:border-r">
          <section>
            <header className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-3.5 sm:px-6">
              <div>
                <h2 className="type-ui text-[var(--text)]">Failing runs</h2>
                {visibleAlerts.length > 0 ? (
                  <p className="type-meta mt-1">
                    {attentionFails} fail · {attentionWarns} warn
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="type-meta text-[var(--accent)]"
                  onClick={openAlerts}
                >
                  Alerts
                </button>
                <Link
                  href="/issues"
                  className="type-meta text-[var(--accent)]"
                >
                  Issues
                </Link>
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
              </div>
            </header>

            {visibleAlerts.length === 0 ? (
              <EmptyState
                title="All clear"
                body={
                  dismissedCount > 0
                    ? `${dismissedCount} dismissed`
                    : undefined
                }
                action={
                  dismissedCount > 0 ? (
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
                {visibleAlerts.map((trace) => (
                  <AttentionCard
                    key={trace.id}
                    trace={trace}
                    onDismiss={() => alerts.dismiss(trace.id)}
                  />
                ))}
              </ul>
            )}
          </section>

          <section>
            <header className="flex items-center justify-between gap-3 border-b border-t border-[var(--line)] px-5 py-3.5 sm:px-6">
              <h2 className="type-ui text-[var(--text)]">Recent runs</h2>
              <Link
                href="/traces"
                className="type-meta text-[var(--accent)]"
              >
                Traces
              </Link>
            </header>
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
                          {agent?.name ?? "—"} · {trace.startedAt}
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
          </section>
        </div>

        <aside className="min-w-0">
          <header className="flex items-center justify-between border-b border-[var(--line)] px-5 py-3.5 sm:px-6">
            <h2 className="type-ui text-[var(--text)]">Fleet</h2>
            <Link href="/agents" className="type-meta text-[var(--accent)]">
              Agents
            </Link>
          </header>
          <ul>
            {fleet.map((agent) => (
              <li key={agent.id} className="border-b border-[var(--line)]">
                <Link
                  href={`/agents?id=${agent.id}`}
                  className="block px-5 py-4 transition-colors hover:bg-[var(--accent-muted)] sm:px-6"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="type-mono !text-[var(--text)]">{agent.name}</p>
                    <AgentStatusBadge status={agent.status} />
                  </div>
                  <p className="type-meta mt-1.5">
                    {agent.runs24h} runs ·{" "}
                    <span
                      className={
                        agent.successRate >= 0.95
                          ? "text-[var(--success)]"
                          : agent.successRate < 0.8
                            ? "text-[var(--error)]"
                            : undefined
                      }
                    >
                      {(agent.successRate * 100).toFixed(0)}% ok
                    </span>
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
                    value: `${(snap.errorRate * 100).toFixed(1)}%`,
                  },
                  {
                    label: "Warnings",
                    value: String(snap.warnings.length),
                  },
                ].map((row) => (
                  <div key={row.label} className="flex justify-between gap-3">
                    <dt className="type-meta">{row.label}</dt>
                    <dd className="type-mono !text-[var(--text)]">{row.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}
