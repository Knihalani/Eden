"use client";

import { useEffect, useState } from "react";
import { Server, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { useOrg } from "@/hooks/use-org";
import { mcpApi, type McpAuthFailureRow, type McpGraphEdge, type McpServerRow } from "@/lib/api";

export default function McpObservabilityPage() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const [servers, setServers] = useState<McpServerRow[]>([]);
  const [failures, setFailures] = useState<McpAuthFailureRow[]>([]);
  const [edges, setEdges] = useState<McpGraphEdge[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      mcpApi.listFleetServers(orgId),
      mcpApi.fleetAuthFailures(orgId),
      mcpApi.fleetGraph(orgId),
    ])
      .then(([s, f, g]) => {
        if (cancelled) return;
        setServers(s.data ?? []);
        setFailures(f.data ?? []);
        setEdges(g.data ?? []);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load MCP dashboard");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Server}
        title="MCP Observability"
        subtitle="Fleet health, auth failures, and agent → server graph (N02)"
      />

      {loading && (
        <p className="text-sm text-[var(--text-muted)]">Loading MCP fleet…</p>
      )}
      {error && (
        <p className="text-sm text-[var(--error)]">{error}</p>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-elev-1)] p-4">
          <p className="text-xs text-[var(--text-muted)]">Servers (7d)</p>
          <p className="mt-1 text-2xl font-mono tabular-nums">{servers.length}</p>
        </div>
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-elev-1)] p-4">
          <p className="text-xs text-[var(--text-muted)]">Auth failures (open)</p>
          <p className="mt-1 text-2xl font-mono tabular-nums text-[var(--error)]">
            {failures.length}
          </p>
        </div>
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-elev-1)] p-4">
          <p className="text-xs text-[var(--text-muted)]">Agent → server edges</p>
          <p className="mt-1 text-2xl font-mono tabular-nums">{edges.length}</p>
        </div>
      </div>

      <section className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-elev-1)]">
        <div className="border-b border-[var(--border-default)] px-4 py-3">
          <h2 className="text-sm font-semibold">MCP servers</h2>
        </div>
        <div className="divide-y divide-[var(--border-subtle)]">
          {servers.length === 0 && !loading ? (
            <p className="px-4 py-6 text-sm text-[var(--text-muted)]">
              No MCP server activity in the last 7 days.
            </p>
          ) : (
            servers.map((s) => (
              <div key={s.server_name} className="flex items-center justify-between px-4 py-3 text-sm">
                <div>
                  <p className="font-mono">{s.server_name}</p>
                  <p className="text-[11px] text-[var(--text-muted)]">
                    {(s.tool_names ?? []).slice(0, 4).join(", ") || "—"}
                  </p>
                </div>
                <div className="text-right font-mono text-xs tabular-nums">
                  <p>{s.call_count_7d ?? 0} calls</p>
                  {s.transport && (
                    <p className="text-[var(--text-muted)]">{s.transport}</p>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-elev-1)]">
        <div className="border-b border-[var(--border-default)] px-4 py-3 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-[var(--error)]" />
          <h2 className="text-sm font-semibold">Recent auth failures</h2>
        </div>
        <div className="divide-y divide-[var(--border-subtle)] max-h-64 overflow-y-auto">
          {failures.length === 0 && !loading ? (
            <p className="px-4 py-6 text-sm text-[var(--text-muted)]">No open auth failures.</p>
          ) : (
            failures.map((f) => (
              <div key={f.id} className="px-4 py-3 text-xs">
                <p className="font-mono">
                  {f.server_name} · {f.failure_kind}
                </p>
                <p className="text-[var(--text-muted)]">{f.occurred_at}</p>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
