"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Server } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Skeleton } from "@/components/ui/skeleton";
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

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const [s, f, g] = await Promise.all([
        mcpApi.listFleetServers(orgId),
        mcpApi.fleetAuthFailures(orgId),
        mcpApi.fleetGraph(orgId),
      ]);
      setServers(s.data ?? []);
      setFailures(f.data ?? []);
      setEdges(g.data ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load MCP dashboard");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!currentOrg) {
    return (
      <NoOrgState
        feature="MCP Observability"
        icon={Server}
        description="Select an organization to view MCP fleet health"
      />
    );
  }

  return (
    <PageContent size="wide">
      <PageHeader
        icon={Server}
        title="MCP Observability"
        subtitle="Fleet health, auth failures, and agent → server graph (N02)"
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            loading={loading}
            className="min-h-[44px]"
            aria-label="Refresh MCP fleet data"
          >
            <RefreshCw className="h-4 w-4 mr-1.5" aria-hidden />
            Refresh
          </Button>
        }
      />

      {loading && (
        <div className="space-y-6" aria-busy="true" aria-live="polite">
          <div className="grid gap-4 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-48 w-full rounded-lg" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      )}

      {!loading && error && (
        <ErrorState
          title="Could not load MCP dashboard"
          message={error}
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() => void load()}
              className="min-h-[44px]"
            >
              Try again
            </Button>
          }
        />
      )}

      {!loading && !error && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
              <p className="text-xs text-[var(--text-muted)]">Servers (7d)</p>
              <p className="mt-1 text-2xl font-mono tabular-nums">{servers.length}</p>
            </div>
            <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
              <p className="text-xs text-[var(--text-muted)]">Auth failures (open)</p>
              <p className="mt-1 text-2xl font-mono tabular-nums text-[var(--error)]">
                {failures.length}
              </p>
            </div>
            <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
              <p className="text-xs text-[var(--text-muted)]">Agent → server edges</p>
              <p className="mt-1 text-2xl font-mono tabular-nums">{edges.length}</p>
            </div>
          </div>

          <section className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)]">
            <div className="border-b border-[var(--border-default)] px-4 py-3">
              <h2 className="text-sm font-semibold">MCP servers</h2>
            </div>
            <div className="divide-y divide-[var(--border-subtle)]">
              {servers.length === 0 ? (
                <p className="px-4 py-6 text-sm text-[var(--text-muted)]">
                  No MCP server activity in the last 7 days.
                </p>
              ) : (
                servers.map((s) => (
                  <div
                    key={s.server_name}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-sm min-h-[44px]"
                  >
                    <div className="min-w-0">
                      <p className="font-mono truncate">{s.server_name}</p>
                      <p className="text-[11px] text-[var(--text-muted)] truncate">
                        {(s.tool_names ?? []).slice(0, 4).join(", ") || "—"}
                      </p>
                    </div>
                    <div className="text-right font-mono text-xs tabular-nums shrink-0">
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

          <section className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)]">
            <div className="border-b border-[var(--border-default)] px-4 py-3">
              <h2 className="text-sm font-semibold">Recent auth failures</h2>
            </div>
            <div className="divide-y divide-[var(--border-subtle)] max-h-64 overflow-y-auto">
              {failures.length === 0 ? (
                <p className="px-4 py-6 text-sm text-[var(--text-muted)]">
                  No open auth failures.
                </p>
              ) : (
                failures.map((f) => (
                  <div key={f.id} className="px-4 py-3 text-xs min-h-[44px]">
                    <p className="font-mono">
                      {f.server_name} · {f.failure_kind}
                    </p>
                    <p className="text-[var(--text-muted)]">{f.occurred_at}</p>
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      )}
    </PageContent>
  );
}
