"use client";

import { useMemo } from "react";
import { EmptyState } from "@/lab/lab-ui";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { fleetApi, type DelegationGraphEdge } from "@/lib/api/resources";
import { SHELL_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { cn } from "@/lib/utils";

// FEAT-66: org-wide agent delegation graph. Backend is org-scoped
// (`GET /orgs/{org_id}/fleet/delegation`, FleetService.delegation_graph),
// so this tab fetches the whole graph and highlights the rows touching
// the current agent rather than asking the backend for a per-agent slice.

function isFeatureUnavailable(err: unknown): boolean {
  const status =
    (err as { status?: number; statusCode?: number } | null)?.status ??
    (err as { statusCode?: number } | null)?.statusCode;
  if (status === 403 || status === 404) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /403|404|feature|flag|not found|forbidden/i.test(msg);
}

function trustTone(trust: number): string {
  if (trust >= 0.8) return "text-[var(--success)]";
  if (trust >= 0.5) return "text-[var(--text)]";
  return "text-[var(--error)]";
}

export function AgentDelegationTab({
  orgId,
  agentId,
}: {
  orgId: string | null;
  agentId: string;
}) {
  const graphQuery = useOrgQuery(
    queryKeys.fleet.delegation(orgId),
    orgId,
    () => fleetApi.delegationGraph(orgId!),
    SHELL_QUERY,
  );

  const nodes = useMemo(() => graphQuery.data?.data?.nodes ?? [], [graphQuery.data]);
  const edges = useMemo(() => graphQuery.data?.data?.edges ?? [], [graphQuery.data]);

  const nodeLabel = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n.label || n.id]));
    return (id: string) => byId.get(id) ?? id;
  }, [nodes]);

  const relatedEdges = useMemo(
    () => edges.filter((e) => e.source === agentId || e.target === agentId),
    [edges, agentId],
  );

  if (graphQuery.isLoading) {
    return <QueryLoadingPanel label="Loading delegation graph…" />;
  }

  if (graphQuery.isError) {
    if (isFeatureUnavailable(graphQuery.error)) {
      return (
        <EmptyState
          title="Delegation graph not available"
          body="Org-wide delegation tracking (fleet_health_v1) isn't enabled for this workspace yet."
          compact
        />
      );
    }
    return (
      <div className="p-5">
        <QueryErrorPanel
          error={graphQuery.error}
          onRetry={() => void graphQuery.refetch()}
        />
      </div>
    );
  }

  if (nodes.length === 0 || edges.length === 0) {
    return (
      <EmptyState
        title="No delegation activity"
        body="Agent-to-agent delegation calls show up here once agents in this org start delegating to each other (last 7 days)."
        compact
      />
    );
  }

  return (
    <div className="space-y-5 p-4 sm:p-5">
      <div>
        <h3 className="type-ui">Delegation graph</h3>
        <p className="type-meta mt-0.5">
          Org-wide agent-to-agent delegation · last 7 days · {nodes.length} agents ·{" "}
          {edges.length} delegation edges
        </p>
      </div>

      <div>
        <h4 className="type-label mb-1.5">Agents &amp; trust scores</h4>
        <NodeTable nodes={nodes} highlightId={agentId} />
      </div>

      {relatedEdges.length > 0 ? (
        <div>
          <h4 className="type-label mb-1.5">This agent&rsquo;s delegations</h4>
          <EdgeTable edges={relatedEdges} nodeLabel={nodeLabel} highlightId={agentId} />
        </div>
      ) : (
        <p className="type-meta">
          This agent has no delegation calls in or out over the last 7 days.
        </p>
      )}

      <div>
        <h4 className="type-label mb-1.5">Full org graph</h4>
        <EdgeTable edges={edges} nodeLabel={nodeLabel} highlightId={agentId} />
      </div>
    </div>
  );
}

function NodeTable({
  nodes,
  highlightId,
}: {
  nodes: Array<{ id: string; label: string; delegation_trust: number }>;
  highlightId?: string;
}) {
  return (
    <div className="max-h-56 overflow-auto rounded border border-[var(--line)]">
      <table className="w-full min-w-[20rem] border-collapse text-left">
        <thead className="sticky top-0 z-[1] bg-[var(--bg)]">
          <tr>
            <th className="type-label border-b border-[var(--line)] px-3 py-2.5 whitespace-nowrap">
              Agent
            </th>
            <th className="type-label border-b border-[var(--line)] px-3 py-2.5 whitespace-nowrap">
              Delegation trust
            </th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => (
            <tr
              key={n.id}
              className={cn(
                "border-b border-[var(--line)] last:border-b-0 hover:bg-[var(--accent-muted)]",
                n.id === highlightId && "bg-[var(--accent-muted)]",
              )}
            >
              <td className="type-mono px-3 py-2 !text-[0.75rem] !text-[var(--text)] whitespace-nowrap">
                {n.label || n.id}
              </td>
              <td className="type-mono px-3 py-2 !text-[0.75rem] whitespace-nowrap">
                <span className={trustTone(n.delegation_trust)}>
                  {(n.delegation_trust * 100).toFixed(0)}%
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EdgeTable({
  edges,
  nodeLabel,
  highlightId,
}: {
  edges: DelegationGraphEdge[];
  nodeLabel: (id: string) => string;
  highlightId?: string;
}) {
  return (
    <div className="max-h-80 overflow-auto rounded border border-[var(--line)]">
      <table className="w-full min-w-[36rem] border-collapse text-left">
        <thead className="sticky top-0 z-[1] bg-[var(--bg)]">
          <tr>
            <th className="type-label border-b border-[var(--line)] px-3 py-2.5 whitespace-nowrap">
              Source
            </th>
            <th className="type-label border-b border-[var(--line)] px-3 py-2.5 whitespace-nowrap">
              Target
            </th>
            <th className="type-label border-b border-[var(--line)] px-3 py-2.5 whitespace-nowrap">
              Calls (7d)
            </th>
            <th className="type-label border-b border-[var(--line)] px-3 py-2.5 whitespace-nowrap">
              Error rate
            </th>
            <th className="type-label border-b border-[var(--line)] px-3 py-2.5 whitespace-nowrap">
              Trust
            </th>
            <th className="type-label border-b border-[var(--line)] px-3 py-2.5 whitespace-nowrap">
              Blast radius
            </th>
          </tr>
        </thead>
        <tbody>
          {edges.map((e, i) => {
            const isHighlighted =
              !!highlightId && (e.source === highlightId || e.target === highlightId);
            return (
              <tr
                key={`${e.source}-${e.target}-${i}`}
                className={cn(
                  "border-b border-[var(--line)] last:border-b-0 hover:bg-[var(--accent-muted)]",
                  isHighlighted && "bg-[var(--accent-muted)]",
                )}
              >
                <td className="type-mono px-3 py-2 !text-[0.75rem] !text-[var(--text)] whitespace-nowrap">
                  {nodeLabel(e.source)}
                </td>
                <td className="type-mono px-3 py-2 !text-[0.75rem] !text-[var(--text)] whitespace-nowrap">
                  {nodeLabel(e.target)}
                </td>
                <td className="type-mono px-3 py-2 !text-[0.75rem] !text-[var(--text)] whitespace-nowrap">
                  {e.call_count_7d}
                </td>
                <td className="type-mono px-3 py-2 !text-[0.75rem] whitespace-nowrap">
                  <span
                    className={
                      e.error_rate_7d > 0.1 ? "text-[var(--error)]" : "text-[var(--text)]"
                    }
                  >
                    {(e.error_rate_7d * 100).toFixed(1)}%
                  </span>
                </td>
                <td className="type-mono px-3 py-2 !text-[0.75rem] whitespace-nowrap">
                  <span className={trustTone(e.delegation_trust)}>
                    {(e.delegation_trust * 100).toFixed(0)}%
                  </span>
                </td>
                <td className="type-mono px-3 py-2 !text-[0.75rem] !text-[var(--text)] whitespace-nowrap">
                  {e.blast_radius.toFixed(2)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
