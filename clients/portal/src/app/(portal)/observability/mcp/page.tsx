"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChevronRight, RefreshCw, Server } from "lucide-react";
import { PageContent } from "@/components/layout/page-content";
import {
  ObserveBackToTraces,
  ObserveLeafHeader,
  WAVE10_FACET_ATTR,
} from "@/app/(portal)/observability/_components/observe-leaf-shell";
import { Button } from "@/components/ui/button";
import { NoOrgState } from "@/components/ui/no-org-state";
import { QueryState } from "@/components/ui/query-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrg } from "@/hooks/use-org";
import {
  mcpApi,
  type McpAuthFailureRow,
  type McpGraphEdge,
  type McpServerRow,
  type McpToolStatRow,
  type McpTrendRow,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const RANGE_OPTIONS = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
] as const;

export default function McpObservabilityPage() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const [servers, setServers] = useState<McpServerRow[]>([]);
  const [failures, setFailures] = useState<McpAuthFailureRow[]>([]);
  const [edges, setEdges] = useState<McpGraphEdge[]>([]);
  const [trends, setTrends] = useState<McpTrendRow[]>([]);
  const [selectedServer, setSelectedServer] = useState<string | null>(null);
  const [tools, setTools] = useState<McpToolStatRow[]>([]);
  const [days, setDays] = useState(7);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const [s, f, g, t] = await Promise.all([
        mcpApi.listFleetServers(orgId),
        mcpApi.fleetAuthFailures(orgId),
        mcpApi.fleetGraph(orgId),
        mcpApi.trends(orgId, days),
      ]);
      setServers(s.data ?? []);
      setFailures(f.data ?? []);
      setEdges(g.data ?? []);
      setTrends(t.data ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load MCP dashboard");
    } finally {
      setLoading(false);
    }
  }, [orgId, days]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!orgId || !selectedServer) {
      setTools([]);
      return;
    }
    let cancelled = false;
    mcpApi
      .listServerTools(orgId, selectedServer)
      .then((res) => {
        if (!cancelled) setTools(res.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setTools([]);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, selectedServer]);

  if (!currentOrg) {
    return (
      <NoOrgState
        feature="MCP Observability"
        icon={Server}
        description="Select an organization to view MCP fleet health"
      />
    );
  }

  const maxTrend = Math.max(1, ...trends.map((t) => t.call_count));

  return (
    <PageContent size="wide">
      <div {...WAVE10_FACET_ATTR} className="contents">
        <ObserveBackToTraces />
        <ObserveLeafHeader
          icon={Server}
          title="MCP"
          subtitle="Fleet health under Traces facets — not a separate Observe hub"
          actions={
            <div className="flex items-center gap-2">
              <div
                role="group"
                aria-label="Time range"
                className="inline-flex rounded-lg border border-[var(--border-default)] p-1"
              >
                {RANGE_OPTIONS.map((opt) => (
                  <button
                    key={opt.days}
                    type="button"
                    onClick={() => setDays(opt.days)}
                    className={cn(
                      "min-h-[44px] min-w-[44px] rounded-md px-3 text-xs font-medium transition-colors",
                      days === opt.days
                        ? "bg-[var(--bg-elev-2)] text-[var(--text-primary)]"
                        : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
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
            </div>
          }
        />
      </div>

      <QueryState
        loading={loading}
        error={error ? new Error(error) : null}
        data={loading || error ? undefined : { servers, failures, edges, trends }}
        onRetry={() => void load()}
        errorTitle="Could not load MCP dashboard"
        loadingSlot={
          <div className="space-y-space-5" aria-busy="true" aria-live="polite">
            <Skeleton className="h-5 w-64 rounded" />
            <Skeleton className="h-28 w-full rounded-lg" />
            <Skeleton className="h-64 w-full rounded-lg" />
          </div>
        }
      >
        {() => (
        <>
          {/* Quiet KPI strip — not a 3-card dashboard wall */}
          <div
            className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-muted)]"
            data-testid="mcp-kpi-strip"
          >
            <span>
              <span className="font-mono tabular-nums text-[var(--text-primary)]">
                {servers.length}
              </span>{" "}
              servers ({days}d)
            </span>
            <span>
              <span
                className={cn(
                  "font-mono tabular-nums",
                  failures.length > 0 ? "text-[var(--error)]" : "text-[var(--text-primary)]",
                )}
              >
                {failures.length}
              </span>{" "}
              auth failures
            </span>
            <span>
              <span className="font-mono tabular-nums text-[var(--text-primary)]">
                {edges.length}
              </span>{" "}
              agent → server edges
            </span>
          </div>

          <section className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-space-4">
            <h2 className="text-sm font-semibold mb-space-3">Call volume trend</h2>
            {trends.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">No MCP telemetry in this range.</p>
            ) : (
              <div className="flex items-end gap-space-2 h-28">
                {trends.map((row) => (
                  <div key={row.day} className="flex-1 min-w-0 flex flex-col items-center gap-space-1">
                    <div
                      className="w-full rounded-t bg-[var(--accent)]/70"
                      style={{
                        height: `${Math.round((row.call_count / maxTrend) * 100)}%`,
                        minHeight: row.call_count ? 4 : 0,
                      }}
                      title={`${row.call_count} calls`}
                    />
                    <span className="text-2xs text-[var(--text-muted)] truncate w-full text-center font-mono">
                      {row.day.slice(5)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="grid gap-space-4 lg:grid-cols-2">
            <section className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)]">
              <div className="border-b border-[var(--border-default)] px-space-4 py-space-3">
                <h2 className="text-sm font-semibold">MCP servers</h2>
              </div>
              <div className="divide-y divide-[var(--border-subtle)]">
                {servers.length === 0 ? (
                  <p className="px-space-4 py-space-6 text-sm text-[var(--text-muted)]">
                    No MCP server activity in this range.
                  </p>
                ) : (
                  servers.map((s) => (
                    <button
                      key={s.server_name}
                      type="button"
                      onClick={() => setSelectedServer(s.server_name)}
                      className={cn(
                        "flex w-full items-center justify-between px-space-4 py-space-3 text-sm text-left min-h-11 hover:bg-[var(--bg-elev-2)] transition-colors",
                        selectedServer === s.server_name && "bg-[var(--bg-elev-2)]",
                      )}
                    >
                      <div className="min-w-0">
                        <p className="font-mono truncate">{s.server_name}</p>
                        <p className="text-xs text-[var(--text-muted)] truncate">
                          {(s.tool_names ?? []).slice(0, 4).join(", ") || "—"}
                        </p>
                      </div>
                      <div className="flex items-center gap-space-2 text-right font-mono text-xs tabular-nums shrink-0">
                        <div>
                          <p>{s.call_count_7d ?? 0} calls</p>
                          {s.transport && (
                            <p className="text-[var(--text-muted)]">{s.transport}</p>
                          )}
                        </div>
                        <ChevronRight className="h-4 w-4 text-[var(--text-muted)]" />
                      </div>
                    </button>
                  ))
                )}
              </div>
            </section>

            <section className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)]">
              <div className="border-b border-[var(--border-default)] px-space-4 py-space-3">
                <h2 className="text-sm font-semibold">
                  {selectedServer ? `Tools · ${selectedServer}` : "Select a server"}
                </h2>
              </div>
              <div className="divide-y divide-[var(--border-subtle)] max-h-80 overflow-y-auto">
                {!selectedServer ? (
                  <p className="px-space-4 py-space-6 text-sm text-[var(--text-muted)]">
                    Tap a server to drill into tool call stats.
                  </p>
                ) : tools.length === 0 ? (
                  <p className="px-space-4 py-space-6 text-sm text-[var(--text-muted)]">
                    No tool stats for this server.
                  </p>
                ) : (
                  tools.map((tool) => (
                    <div
                      key={tool.tool_name}
                      className="flex items-center justify-between px-space-4 py-space-3 text-xs min-h-11"
                    >
                      <span className="font-mono">{tool.tool_name}</span>
                      <span className="font-mono tabular-nums">{tool.call_count_7d ?? 0} calls</span>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>

          <section className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)]">
            <div className="border-b border-[var(--border-default)] px-space-4 py-space-3 flex items-center gap-space-2">
              <AlertTriangle className="h-4 w-4 text-[var(--error)]" />
              <h2 className="text-sm font-semibold">Recent auth failures</h2>
            </div>
            <div className="divide-y divide-[var(--border-subtle)] max-h-64 overflow-y-auto">
              {failures.length === 0 ? (
                <p className="px-space-4 py-space-6 text-sm text-[var(--text-muted)]">No open auth failures.</p>
              ) : (
                failures.map((f) => (
                  <div key={f.id} className="px-space-4 py-space-3 text-xs min-h-11">
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
      </QueryState>
    </PageContent>
  );
}
