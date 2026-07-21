"use client";

import { PageHeader } from "@/components/layout/page-header";
import { useEmbeddedSurface } from "@/components/layout/embedded-surface";
import { CoreResourcePage } from "@/components/portal-os";
import {
  Loader2,
  Network,
  ShieldAlert,
  Activity,
  GitBranch,
  BookOpen,
  Key,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { api, fleetApi } from "@/lib/api";
import { ApiError } from "@/lib/api/core";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { NoOrgState } from "@/components/ui/no-org-state";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryState } from "@/components/ui/query-state";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { STICKY_FIRST_TD } from "@/components/ui/table-sticky";
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
        embedded ? null : (
          <PageHeader
            title="Fleet Health"
            subtitle="Agent health rollup from traces and issues — not a full fleet SRE product yet. Use Issues and the SDK while agents populate."
            icon={Network}
            actions={
              <div className="flex flex-wrap items-center gap-space-2">
                <Button asChild variant="outline" className="min-h-11">
                  <Link href="/issues">Open issues</Link>
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="default"
                      className="min-h-11"
                      aria-label="Related surfaces"
                    >
                      More
                      <ChevronDown className="h-4 w-4" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[12rem]">
                    <DropdownMenuLabel>Related</DropdownMenuLabel>
                    <DropdownMenuItem asChild>
                      <Link href="/agents">Agents</Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/improve">Improve</Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/audit-trail">Audit trail</Link>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            }
          />
        )
      }
      toolbar={undefined}
      kpiStrip={
        // W11: when nested under Agents, skip Card KPI strip (embed chrome leak).
        // Standalone keeps thin status chips; Cards only on the full leaf.
        showKpis && !embedded ? (
          <div
            className="flex flex-wrap gap-space-4 text-sm"
            data-testid="fleet-kpi-strip"
          >
            <div>
              <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Agents</p>
              <p className="text-lg font-semibold tabular-nums text-[var(--text-primary)]">{agents.length}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">SLO breaches</p>
              <p className={cn("text-lg font-semibold tabular-nums", slaCount > 0 ? "text-[var(--error)]" : "text-[var(--text-primary)]")}>
                {slaCount}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Critical</p>
              <p className="text-lg font-semibold tabular-nums text-[var(--text-primary)]">{criticalCount}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Delegation</p>
              <p className="text-lg font-semibold tabular-nums text-[var(--text-primary)]">
                {delegationQuery.isSuccess ? edges.length : "—"}
              </p>
            </div>
            <div data-testid="f64-agentic-fleet">
              <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Agentic quality</p>
              <p className="text-lg font-semibold tabular-nums text-[var(--text-primary)]">
                {agenticScore == null ? "—" : `${Math.round(agenticScore * 100)}%`}
              </p>
            </div>
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
          ) : (
            <QueryState
              loading={loading && agents.length === 0}
              error={errorMessage ? new Error(errorMessage) : null}
              data={summaryQuery.data ?? (errorMessage ? undefined : { data: { agents: [] } })}
              onRetry={() => {
                void summaryQuery.refetch();
                if (tab === "heatmap") void heatmapQuery.refetch();
                if (tab === "delegation") void delegationQuery.refetch();
              }}
              errorTitle="Could not load fleet"
              isEmpty={() => false}
              loadingSlot={
                <div className="flex items-center justify-center p-12 text-sm text-[var(--text-muted)]">
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading fleet…
                </div>
              }
            >
              {() => (
            <Tabs
              value={tab}
              onValueChange={(v) => setTab(v as FleetTab)}
              className="space-y-space-4"
            >
              <TabsList
                variant="underline"
                aria-label="Fleet views"
                className="h-auto w-full justify-start gap-1 bg-transparent"
              >
                <TabsTrigger variant="underline" value="agents" className="min-h-11">
                  Agents
                </TabsTrigger>
                <TabsTrigger variant="underline" value="heatmap" className="min-h-11">
                  Heatmap
                </TabsTrigger>
                <TabsTrigger variant="underline" value="delegation" className="min-h-11">
                  Delegation
                </TabsTrigger>
              </TabsList>

              <TabsContent value="agents" className="mt-0">
                {agents.length === 0 ? (
                  <EmptyState
                    icon={Network}
                    title="No agents in the fleet yet"
                    description="No fleet agents yet. Rows appear after agents send traces or stumbles. Triage failures in Issues, or install the SDK to begin ingest."
                    size="lg"
                    action={<FleetOnboardingActions />}
                  />
                ) : (
                  <div
                    className="overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]"
                    data-testid="fleet-agents-table" data-wave10-fleet="table" data-wave11-mobile="cards"
                  >
                    <div className="hidden md:grid grid-cols-[minmax(0,1.5fr)_5rem_6rem_5rem_5rem_5rem_auto] gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                      <span>Agent</span>
                      <span>Tier</span>
                      <span>Issues</span>
                      <span>Stumbles</span>
                      <span>Eval</span>
                      <span>Severity</span>
                      <span className="text-right">Links</span>
                    </div>
                    <ul className="divide-y divide-[var(--border-subtle)]">
                      {agents.map((a) => (
                        <li
                          key={a.agent_id}
                          className="grid grid-cols-1 md:grid-cols-[minmax(0,1.5fr)_5rem_6rem_5rem_5rem_5rem_auto] gap-1 md:gap-2 px-3 py-2.5 items-center hover:bg-[var(--bg-tertiary)]/40"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                                {a.display_name || a.agent_id}
                              </span>
                              {a.drift_flagged ? (
                                <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--error-dim)] text-[var(--error)] flex items-center gap-0.5 shrink-0">
                                  <Activity className="h-3 w-3" /> Drift
                                </span>
                              ) : null}
                              {a.slo_breach ? (
                                <span className="text-xs text-[var(--error)] flex items-center gap-0.5 shrink-0">
                                  <ShieldAlert className="h-3 w-3" /> SLO
                                </span>
                              ) : null}
                            </div>
                            <p className="text-xs font-mono text-[var(--text-muted)] truncate">{a.agent_id}</p>
                            <div className="flex flex-wrap gap-1 mt-1 md:hidden">
                              {a.autonomy_mode ? (
                                <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--accent-faint)] text-[var(--accent)]">
                                  {AUTONOMY_LABEL[a.autonomy_mode] ?? a.autonomy_mode}
                                </span>
                              ) : null}
                            </div>
                          </div>
                          <span className="text-xs uppercase tracking-wide text-[var(--text-muted)]">{a.tier}</span>
                          <span className="text-sm tabular-nums text-[var(--text-primary)]">
                            {a.open_issues}
                            {(a.open_p0_issues ?? 0) > 0 ? (
                              <span className="text-[var(--error)] ml-1 text-xs">({a.open_p0_issues} P0)</span>
                            ) : null}
                          </span>
                          <span className="text-sm tabular-nums text-[var(--text-primary)]">{a.stumble_count_7d}</span>
                          <span className={cn("text-sm tabular-nums", a.slo_breach ? "text-[var(--error)]" : "text-[var(--text-primary)]")}>
                            {a.eval_pass_rate_24h != null ? `${Math.round(a.eval_pass_rate_24h * 100)}%` : "—"}
                          </span>
                          <span className="text-sm tabular-nums text-[var(--text-primary)]">{a.severity_score}</span>
                          <div className="flex flex-wrap gap-2 md:justify-end">
                            <Button asChild variant="link" size="sm" className="min-h-11 px-0 h-auto">
                              <Link href={`/issues?agent=${encodeURIComponent(a.agent_id)}`}>Issues</Link>
                            </Button>
                            <Button asChild variant="link" size="sm" className="min-h-11 px-0 h-auto">
                              <Link href={`/improve?agent=${encodeURIComponent(a.agent_id)}`}>Improve</Link>
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="heatmap" className="mt-0">
                {heatmap.length === 0 ? (
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
                          <th
                            className={cn(
                              STICKY_FIRST_TD,
                              "text-left p-2 text-[var(--text-muted)]",
                            )}
                          >
                            Agent
                          </th>
                          {heatmapKinds.map((kind) => (
                            <th key={kind} className="p-2 text-[var(--text-muted)] font-mono">{kind}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {heatmapAgents.map((agentId) => (
                          <tr key={agentId} className="border-t border-[var(--border-subtle)]">
                            <td className={cn(STICKY_FIRST_TD, "p-2 font-mono")}>
                              {agentId}
                            </td>
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
                )}
              </TabsContent>

              <TabsContent value="delegation" className="mt-0">
                {edges.length === 0 ? (
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
              </TabsContent>
            </Tabs>
              )}
            </QueryState>
          )}
        </>
      }
    />
  );
}

