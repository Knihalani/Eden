"use client";

import { useEffect, useState } from "react";
import { Server, AlertTriangle, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { useOrg } from "@/hooks/use-org";
import {
  mcpApi,
  type McpAuthFailureRow,
  type McpGraphEdge,
  type McpServerRow,
  type McpToolStatRow,
  type McpTrendRow,
} from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
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

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      mcpApi.listFleetServers(orgId),
      mcpApi.fleetAuthFailures(orgId),
      mcpApi.fleetGraph(orgId),
      mcpApi.trends(orgId, days),
    ])
      .then(([s, f, g, t]) => {
        if (cancelled) return;
        setServers(s.data ?? []);
        setFailures(f.data ?? []);
        setEdges(g.data ?? []);
        setTrends(t.data ?? []);
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
  }, [orgId, days]);

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

  const maxTrend = Math.max(1, ...trends.map((t) => t.call_count));

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Server}
        title="MCP Observability"
        subtitle="Fleet health, auth failures, trends, and agent → server drill-down (N02)"
        actions={
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
        }
      />

      {loading ? (
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
      ) : null}
      {error && (
        <p className="text-sm text-[var(--error)]">{error}</p>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-elev-1)] p-4">
          <p className="text-xs text-[var(--text-muted)]">Servers ({days}d)</p>
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

      <section className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-elev-1)] p-4">
        <h2 className="text-sm font-semibold mb-3">Call volume trend</h2>
        {trends.length === 0 && !loading ? (
          <p className="text-sm text-[var(--text-muted)]">No MCP telemetry in this range.</p>
        ) : (
          <div className="flex items-end gap-2 h-28">
            {trends.map((row) => (
              <div key={row.day} className="flex-1 min-w-0 flex flex-col items-center gap-1">
                <div
                  className="w-full rounded-t bg-[var(--accent)]/70"
                  style={{ height: `${Math.round((row.call_count / maxTrend) * 100)}%`, minHeight: row.call_count ? 4 : 0 }}
                  title={`${row.call_count} calls`}
                />
                <span className="text-[10px] text-[var(--text-muted)] truncate w-full text-center">
                  {row.day.slice(5)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-elev-1)]">
          <div className="border-b border-[var(--border-default)] px-4 py-3">
            <h2 className="text-sm font-semibold">MCP servers</h2>
          </div>
          <div className="divide-y divide-[var(--border-subtle)]">
            {servers.length === 0 && !loading ? (
              <p className="px-4 py-6 text-sm text-[var(--text-muted)]">
                No MCP server activity in this range.
              </p>
            ) : (
              servers.map((s) => (
                <button
                  key={s.server_name}
                  type="button"
                  onClick={() => setSelectedServer(s.server_name)}
                  className={cn(
                    "flex w-full items-center justify-between px-4 py-3 text-sm text-left min-h-[44px] hover:bg-[var(--bg-elev-2)] transition-colors",
                    selectedServer === s.server_name && "bg-[var(--bg-elev-2)]",
                  )}
                >
                  <div>
                    <p className="font-mono">{s.server_name}</p>
                    <p className="text-[11px] text-[var(--text-muted)]">
                      {(s.tool_names ?? []).slice(0, 4).join(", ") || "—"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-right font-mono text-xs tabular-nums">
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

        <section className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-elev-1)]">
          <div className="border-b border-[var(--border-default)] px-4 py-3">
            <h2 className="text-sm font-semibold">
              {selectedServer ? `Tools · ${selectedServer}` : "Select a server"}
            </h2>
          </div>
          <div className="divide-y divide-[var(--border-subtle)] max-h-80 overflow-y-auto">
            {!selectedServer ? (
              <p className="px-4 py-6 text-sm text-[var(--text-muted)]">
                Tap a server to drill into tool call stats.
              </p>
            ) : tools.length === 0 ? (
              <p className="px-4 py-6 text-sm text-[var(--text-muted)]">No tool stats for this server.</p>
            ) : (
              tools.map((tool) => (
                <div key={tool.tool_name} className="flex items-center justify-between px-4 py-3 text-xs min-h-[44px]">
                  <span className="font-mono">{tool.tool_name}</span>
                  <span className="font-mono tabular-nums">{tool.call_count_7d ?? 0} calls</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

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
    </div>
  );
}
