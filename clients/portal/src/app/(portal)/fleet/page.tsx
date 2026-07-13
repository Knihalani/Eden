"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { fleetApi, type FleetAgentCard } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageContent } from "@/components/layout/page-content";
import { PageHeader } from "@/components/layout/page-header";
import { Loader2, Network, ShieldAlert } from "lucide-react";

export default function FleetPage() {
  const { currentOrg } = useOrg();
  const [agents, setAgents] = useState<FleetAgentCard[]>([]);
  const [edges, setEdges] = useState<Array<{ source: string; target: string; call_count_7d: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    try {
      const [summary, delegation] = await Promise.all([
        fleetApi.summary(currentOrg.id),
        fleetApi.delegation(currentOrg.id),
      ]);
      setAgents(summary.data?.agents ?? []);
      setEdges(delegation.data?.edges ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load fleet health");
    } finally {
      setLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => {
    load();
  }, [load]);

  if (!currentOrg) {
    return (
      <NoOrgState
        feature="Fleet Health"
        icon={Network}
        description="Select an organization to view multi-agent fleet health"
      />
    );
  }

  return (
    <PageContent size="default">
      <PageHeader
        title="Fleet Health"
        subtitle="Agent health cards, SLO breaches, and delegation graph for your multi-agent platform."
        icon={Network}
      />

      {loading ? (
        <div className="flex items-center justify-center p-12 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading fleet…
        </div>
      ) : error ? (
        <Card padding="lg">
          <p className="text-sm text-[var(--error)]">{error}</p>
        </Card>
      ) : agents.length === 0 ? (
        <Card padding="lg">
          <p className="text-sm text-[var(--text-muted)]">
            No agents discovered yet. Agents appear here after their first trace or stumble.
          </p>
        </Card>
      ) : (
        <div className="space-y-6">
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
                  className="mt-3 inline-block text-xs text-[var(--accent)] hover:underline"
                >
                  View issues →
                </Link>
              </div>
            ))}
          </div>

          {edges.length > 0 && (
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
        </div>
      )}
    </PageContent>
  );
}
