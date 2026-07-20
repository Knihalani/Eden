"use client";

import { PageHeader } from "@/components/layout/page-header";
import { useEmbeddedSurface } from "@/components/layout/embedded-surface";
import { CoreResourcePage, CrossLinkBar } from "@/components/portal-os";
import {
  Loader2,
  Network,
  ShieldAlert,
  Activity,
  GitBranch,
  BookOpen,
  Key,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { api, fleetApi } from "@/lib/api";
import { ApiError } from "@/lib/api/core";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { Card } from "@/components/ui/card";
import { NoOrgState } from "@/components/ui/no-org-state";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";

type FleetTab = "agents" | "heatmap" | "delegation";

const AUTONOMY_LABEL: Record<string, string> = {
  autonomous: "Autonomous",
  assisted: "Assisted",
  observe: "Observe only",
};

function isFleetUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

function FleetOnboardingActions() {
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-2"
      data-testid="fleet-onboarding-ctas"
    >
      <Button asChild className="min-h-11">
        <Link href="/issues">View issues</Link>
      </Button>
      <Button asChild variant="outline" className="min-h-11">
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
  );
}

export default function FleetPage() {
  const { currentOrg } = useOrg();
  const embedded = useEmbeddedSurface();
  const orgId = currentOrg?.id ?? null;
  const [tab, setTab] = useState<FleetTab>("agents");

  // Always-on: summary + SLA + agentic (agents tab + KPI strip).
  // Tab-gated: heatmap / delegation — were firing all five on mount.
  const summaryQuery = useOrgQuery(
    queryKeys.fleet.summary(orgId),
    orgId,
    () => fleetApi.summary(orgId!),
  );
  const heatmapQuery = useOrgQuery(
    queryKeys.fleet.heatmap(orgId),
    orgId,
    () => fleetApi.heatmap(orgId!),
    { enabled: tab === "heatmap" },
  );
  const delegationQuery = useOrgQuery(
    queryKeys.fleet.delegation(orgId),
    orgId,
    () => fleetApi.delegation(orgId!),
    { enabled: tab === "delegation" },
  );
  const slaQuery = useOrgQuery(
    queryKeys.fleet.slaBreaches(orgId),
    orgId,
    () => fleetApi.slaBreaches(orgId!),
  );
  const agenticQuery = useOrgQuery(
    queryKeys.fleet.agentic(orgId),
    orgId,
    () => api.agenticMetricsSummary(orgId!, 24),
  );

  const agents = summaryQuery.data?.data?.agents ?? [];
  const heatmap = heatmapQuery.data?.data?.cells ?? [];
  const edges = delegationQuery.data?.data?.edges ?? [];
  const slaCount = slaQuery.data?.data?.count ?? summaryQuery.data?.data?.sla_breach_count ?? 0;
  const criticalCount = summaryQuery.data?.data?.critical_count ?? 0;
  const agenticScore =
    agenticQuery.data?.data?.metrics?.action_completion?.score ?? null;
  const loading =
    summaryQuery.isLoading ||
    (tab === "heatmap" && heatmapQuery.isLoading) ||
    (tab === "delegation" && delegationQuery.isLoading);
  const primaryError =
    summaryQuery.error ??
    (tab === "heatmap" ? heatmapQuery.error : null) ??
    (tab === "delegation" ? delegationQuery.error : null) ??
    null;
  const unavailable = isFleetUnavailable(primaryError);
  const errorMessage = unavailable
    ? null
    : (primaryError?.message ?? null);

  if (!currentOrg) {
    return (
      <NoOrgState
        feature="Fleet Health"
        icon={Network}
        description="Select an organization to view multi-agent fleet health"
      />
    );
  }

  const heatmapAgents = [...new Set(heatmap.map((c) => c.agent_id))];
  const heatmapKinds = [...new Set(heatmap.map((c) => c.stumble_kind))];
  const heatmapMax = Math.max(1, ...heatmap.map((c) => c.count));
  const heatmapLookup = new Map(
    heatmap.map((c) => [`${c.agent_id}:${c.stumble_kind}`, c.count]),
  );

  const showKpis = !loading && !primaryError;

  return (
    <CoreResourcePage
      size="default"
      header={
        <PageHeader
          title="Fleet Health"
          subtitle="Agent health rollup from traces and issues — not a full fleet SRE product yet. Use Issues and the SDK while agents populate."
          icon={Network}
          actions={
            <Link
              href="/issues"
              className="text-sm text-[var(--accent)] hover:underline min-h-[44px] inline-flex items-center"
            >
              Open issues →
            </Link>
          }
        />
      }
      toolbar={
        embedded ? undefined : (
          <CrossLinkBar
            className="mb-4"
            links={[
              { label: "Issues", href: "/issues" },
              { label: "Agents", href: "/agents" },
              { label: "Improve", href: "/improve" },
              { label: "Audit trail", href: "/audit-trail" },
            ]}
          />
        )
      }
      kpiStrip={
        showKpis ? (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6" data-testid="fleet-kpi-strip">
            <Card padding="sm" className="text-center">
              <div className="text-2xl font-semibold tabular-nums">{agents.length}</div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Agents</div>
            </Card>
            <Card padding="sm" className="text-center">
              <div className={cn("text-2xl font-semibold tabular-nums", slaCount > 0 && "text-[var(--error)]")}>
                {slaCount}
              </div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">SLO breaches</div>
            </Card>
            <Card padding="sm" className="text-center">
              <div className="text-2xl font-semibold tabular-nums">{criticalCount}</div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Critical tier</div>
            </Card>
            <Card padding="sm" className="text-center">
              <div className="text-2xl font-semibold tabular-nums">
                {delegationQuery.isSuccess ? edges.length : "—"}
              </div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Delegation edges</div>
            </Card>
            <Card padding="sm" className="text-center" data-testid="f64-agentic-fleet">
              <div className="text-2xl font-semibold tabular-nums">
                {agenticScore == null ? "—" : `${Math.round(agenticScore * 100)}%`}
              </div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                Agentic quality
              </div>
            </Card>
          </div>
        ) : null
      }
      table={
        <>
          {unavailable ? (
            <EmptyState
              icon={Network}
              title="Fleet Health is not available yet"
              description="This workspace does not have the fleet health API enabled. Track failures in Issues, or install the SDK to send agent traces."
              size="lg"
              action={<FleetOnboardingActions />}
            />
          ) : errorMessage ? (
            <ErrorState
              className="mb-4"
              title="Could not load fleet"
              message={errorMessage}
              action={
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void summaryQuery.refetch();
                      if (tab === "heatmap") void heatmapQuery.refetch();
                      if (tab === "delegation") void delegationQuery.refetch();
                    }}
                  >
                    Try again
                  </Button>
                  <Button asChild variant="ghost" size="sm">
                    <Link href="/issues">View issues</Link>
                  </Button>
                </div>
              }
            />
          ) : loading && agents.length === 0 ? (
            <div className="flex items-center justify-center p-12 text-sm text-[var(--text-muted)]">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading fleet…
            </div>
          ) : (
            <>
              <div
                role="tablist"
                aria-label="Fleet views"
                className="inline-flex rounded-lg border border-[var(--border-default)] p-1 mb-6"
              >
                {(
                  [
                    ["agents", "Agents"],
                    ["heatmap", "Heatmap"],
                    ["delegation", "Delegation"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    onClick={() => setTab(id)}
                    className={cn(
                      "min-h-[44px] rounded-md px-4 text-sm font-medium transition-colors",
                      tab === id
                        ? "bg-[var(--bg-primary)] text-[var(--text-primary)]"
                        : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {tab === "agents" ? (
                agents.length === 0 ? (
                  <EmptyState
                    icon={Network}
                    title="No agents in the fleet yet"
                    description="Fleet cards appear after agents send traces or stumbles. Until then, triage failures in Issues or install the SDK to start ingest."
                    size="lg"
                    action={<FleetOnboardingActions />}
                  />
                ) : (
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {agents.map((a) => (
                      <div
                        key={a.agent_id}
                        className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4"
                      >
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <h2 className="text-sm font-semibold text-[var(--text-primary)] truncate">
                            {a.display_name || a.agent_id}
                          </h2>
                          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-[var(--border-subtle)] text-[var(--text-muted)]">
                            {a.tier}
                          </span>
                        </div>
                        <p className="text-xs font-mono text-[var(--text-muted)] truncate mb-2">{a.agent_id}</p>
                        <div className="flex flex-wrap gap-1 mb-3">
                          {a.autonomy_mode && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-faint)] text-[var(--accent)]">
                              {AUTONOMY_LABEL[a.autonomy_mode] ?? a.autonomy_mode}
                            </span>
                          )}
                          {a.compliance_profile && a.compliance_profile !== "standard" && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--warning-bg)] text-[var(--warning)]">
                              {a.compliance_profile}
                            </span>
                          )}
                          {a.drift_flagged && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--error-dim)] text-[var(--error)] flex items-center gap-0.5">
                              <Activity className="h-3 w-3" /> Drift
                            </span>
                          )}
                        </div>
                        <dl className="grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <dt className="text-[var(--text-muted)]">Open issues</dt>
                            <dd className="font-semibold text-[var(--text-primary)]">
                              {a.open_issues}
                              {(a.open_p0_issues ?? 0) > 0 && (
                                <span className="text-[var(--error)] ml-1">({a.open_p0_issues} P0)</span>
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-[var(--text-muted)]">Stumbles (7d)</dt>
                            <dd className="font-semibold text-[var(--text-primary)]">{a.stumble_count_7d}</dd>
                          </div>
                          <div>
                            <dt className="text-[var(--text-muted)]">Eval pass (24h)</dt>
                            <dd className={a.slo_breach ? "font-semibold text-[var(--error)]" : "font-semibold text-[var(--text-primary)]"}>
                              {a.eval_pass_rate_24h != null ? `${Math.round(a.eval_pass_rate_24h * 100)}%` : "—"}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-[var(--text-muted)]">Severity</dt>
                            <dd className="font-semibold text-[var(--text-primary)]">{a.severity_score}</dd>
                          </div>
                        </dl>
                        {a.slo_breach && (
                          <p className="mt-2 text-[10px] text-[var(--error)] flex items-center gap-1">
                            <ShieldAlert className="h-3 w-3" /> SLO breach
                          </p>
                        )}
                        <div className="mt-3 flex flex-wrap gap-3">
                          <Link
                            href={`/issues?agent=${encodeURIComponent(a.agent_id)}`}
                            className="text-xs text-[var(--accent)] hover:underline min-h-[44px] leading-[44px]"
                          >
                            Issues →
                          </Link>
                          <Link
                            href={`/improve?agent=${encodeURIComponent(a.agent_id)}`}
                            className="text-xs text-[var(--accent)] hover:underline min-h-[44px] leading-[44px]"
                          >
                            Improve →
                          </Link>
                          <Link
                            href={`/audit-trail?agent=${encodeURIComponent(a.agent_id)}`}
                            className="text-xs text-[var(--accent)] hover:underline min-h-[44px] leading-[44px]"
                          >
                            Audit trail →
                          </Link>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              ) : tab === "heatmap" ? (
                heatmap.length === 0 ? (
                  <EmptyState
                    icon={Activity}
                    title="No stumble heatmap yet"
                    description="Heatmap cells fill after agents stumble in the last 7 days. Check Issues for current failures, or install the SDK to send agent traffic."
                    size="lg"
                    action={<FleetOnboardingActions />}
                  />
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
                    <table className="w-full text-xs">
                      <thead>
                        <tr>
                          <th className="text-left p-2 text-[var(--text-muted)]">Agent</th>
                          {heatmapKinds.map((kind) => (
                            <th key={kind} className="p-2 text-[var(--text-muted)] font-mono">{kind}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {heatmapAgents.map((agentId) => (
                          <tr key={agentId} className="border-t border-[var(--border-subtle)]">
                            <td className="p-2 font-mono">{agentId}</td>
                            {heatmapKinds.map((kind) => {
                              const count = heatmapLookup.get(`${agentId}:${kind}`) ?? 0;
                              const intensity = count / heatmapMax;
                              return (
                                <td key={kind} className="p-2 text-center">
                                  <span
                                    className="inline-block min-w-[2rem] rounded px-1 py-0.5 font-mono tabular-nums"
                                    style={{
                                      backgroundColor: count
                                        ? `color-mix(in srgb, var(--error) ${Math.round(intensity * 70)}%, transparent)`
                                        : undefined,
                                    }}
                                  >
                                    {count || "—"}
                                  </span>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              ) : edges.length === 0 ? (
                <EmptyState
                  icon={GitBranch}
                  title="No delegation edges yet"
                  description="Delegation links appear when parent agents call child agents. Until then, use Issues for failures or the SDK to instrument multi-agent flows."
                  size="lg"
                  action={<FleetOnboardingActions />}
                />
              ) : (
                <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
                  <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
                    <GitBranch className="h-4 w-4" /> Delegation graph (7d)
                  </h2>
                  <ul className="space-y-2 text-xs font-mono text-[var(--text-secondary)]">
                    {edges.slice(0, 30).map((e) => (
                      <li
                        key={`${e.source}-${e.target}`}
                        className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-1"
                      >
                        <span>
                          {e.source} → {e.target}
                        </span>
                        <span className="text-[var(--text-muted)] tabular-nums">
                          {e.call_count_7d} calls
                          {e.error_rate_7d != null && ` · ${Math.round(e.error_rate_7d * 100)}% err`}
                          {e.delegation_trust != null && ` · trust ${e.delegation_trust}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </>
      }
    />
  );
}
