"use client";

import { useState } from "react";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { fleetApi } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { Card } from "@/components/ui/card";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageContent } from "@/components/layout/page-content";
import { PageHeader } from "@/components/layout/page-header";
import { Loader2, Network, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

type FleetTab = "agents" | "heatmap" | "delegation";

export default function FleetPage() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const [tab, setTab] = useState<FleetTab>("agents");

  const summaryQuery = useOrgQuery(
    queryKeys.fleet.summary(orgId),
    orgId,
    () => fleetApi.summary(orgId!),
  );
  const heatmapQuery = useOrgQuery(
    queryKeys.fleet.heatmap(orgId),
    orgId,
    () => fleetApi.heatmap(orgId!),
  );
  const delegationQuery = useOrgQuery(
    queryKeys.fleet.delegation(orgId),
    orgId,
    () => fleetApi.delegation(orgId!),
  );

  const agents = summaryQuery.data?.data?.agents ?? [];
  const heatmap = heatmapQuery.data?.data?.cells ?? [];
  const edges = delegationQuery.data?.data?.edges ?? [];
  const loading = summaryQuery.isLoading || heatmapQuery.isLoading || delegationQuery.isLoading;
  const error =
    summaryQuery.error?.message ?? heatmapQuery.error?.message ?? delegationQuery.error?.message ?? null;

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

  return (
    <PageContent size="default">
      <PageHeader
        title="Fleet Health"
        subtitle="Agent health cards, stumble heatmap, and delegation graph for your multi-agent platform."
        icon={Network}
      />

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

      {loading ? (
        <div className="flex items-center justify-center p-12 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading fleet…
        </div>
      ) : error ? (
        <Card padding="lg">
          <p className="text-sm text-[var(--error)]">{error}</p>
        </Card>
      ) : tab === "agents" ? (
        agents.length === 0 ? (
          <Card padding="lg">
            <p className="text-sm text-[var(--text-muted)]">
              No agents discovered yet. Agents appear here after their first trace or stumble.
            </p>
          </Card>
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
                <p className="text-xs font-mono text-[var(--text-muted)] truncate mb-3">{a.agent_id}</p>
                <dl className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <dt className="text-[var(--text-muted)]">Open issues</dt>
                    <dd className="font-semibold text-[var(--text-primary)]">{a.open_issues}</dd>
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
                <Link
                  href={`/issues?agent=${encodeURIComponent(a.agent_id)}`}
                  className="mt-3 inline-block text-xs text-[var(--accent)] hover:underline min-h-[44px] leading-[44px]"
                >
                  View issues →
                </Link>
              </div>
            ))}
          </div>
        )
      ) : tab === "heatmap" ? (
        heatmap.length === 0 ? (
          <Card padding="lg">
            <p className="text-sm text-[var(--text-muted)]">No stumble heatmap data for the last 7 days.</p>
          </Card>
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
        <Card padding="lg">
          <p className="text-sm text-[var(--text-muted)]">No delegation edges in the last 7 days.</p>
        </Card>
      ) : (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Delegation graph (7d)</h2>
          <ul className="space-y-1 text-xs font-mono text-[var(--text-secondary)]">
            {edges.slice(0, 30).map((e) => (
              <li key={`${e.source}-${e.target}`}>
                {e.source} → {e.target} ({e.call_count_7d} calls)
              </li>
            ))}
          </ul>
        </div>
      )}
    </PageContent>
  );
}
