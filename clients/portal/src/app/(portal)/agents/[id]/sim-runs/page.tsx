"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { agentsApi, type SimRun } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useToast } from "@/components/ui/toast";
import {
  ArrowLeft,
  Beaker,
  ChevronRight,
  Filter,
  Loader2,
  PlayCircle,
  RefreshCw,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
  running: "bg-[var(--accent-faint)] text-[var(--accent)]",
  passed: "bg-[var(--terminal-faint)] text-[var(--terminal)]",
  failed: "bg-[var(--error-bg)] text-[var(--error)]",
  error: "bg-[var(--error-dim)] text-[var(--error)]",
};

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

function formatTime(iso?: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function SimRunsPage() {
  const params = useParams<{ id: string }>();
  const agentId = decodeURIComponent(params.id);
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [runs, setRuns] = useState<SimRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [triggering, setTriggering] = useState(false);

  const load = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    try {
      const data = await agentsApi.listSimRuns(currentOrg.id, agentId, { limit: 50 });
      setRuns(data.runs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load sim runs");
    } finally {
      setLoading(false);
    }
  }, [currentOrg, agentId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (currentOrg) load();
  }, [currentOrg, load]);

  async function handleTrigger() {
    if (!currentOrg) return;
    setTriggering(true);
    try {
      await agentsApi.triggerSimRun(currentOrg.id, agentId, { max_episodes: 5 });
      toast.success("Sim run triggered");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to trigger sim run");
    } finally {
      setTriggering(false);
    }
  }

  const filtered = runs.filter((r) => {
    if (statusFilter && r.status !== statusFilter) return false;
    if (search && !r.id.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  if (!currentOrg) {
    return (
      <NoOrgState
        icon={Beaker}
        feature="Sim runs"
        description="Trigger and inspect sim runs for this agent."
      />
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6 page-enter">
      {/* Header */}
      <div>
        <Link
          href={`/agents/${encodeURIComponent(agentId)}`}
          className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
        >
          <ArrowLeft className="w-3 h-3" />
          Back to agent
        </Link>
        <div className="mt-3 flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[var(--text-primary)] tracking-tight flex items-center gap-2">
              <Beaker className="w-7 h-7 text-[var(--accent)]" />
              Sim runs
            </h1>
            <p className="text-sm text-[var(--text-muted)] mt-1">
              <span className="font-mono">{agentId}</span> · {runs.length} run
              {runs.length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={load}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-sm font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
              Refresh
            </button>
            <button
              onClick={handleTrigger}
              disabled={triggering}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
            >
              {triggering ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <PlayCircle className="w-4 h-4" />
              )}
              Trigger sim run
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-[var(--error)]/20 bg-[var(--error-bg)] text-sm text-[var(--error)]">
          {error}
        </div>
      )}

      {/* Filters */}
      {runs.length > 0 && (
        <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by run id…"
              className="w-full pl-9 pr-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
            />
          </div>
          <div className="relative">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)] pointer-events-none" />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="pl-8 pr-8 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
            >
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="running">Running</option>
              <option value="passed">Passed</option>
              <option value="failed">Failed</option>
              <option value="error">Error</option>
            </select>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && runs.length === 0 && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
        </div>
      )}

      {/* Empty state */}
      {!loading && runs.length === 0 && (
        <Card className="p-8">
          <EmptyState
            icon={Beaker}
            title="No sim runs yet"
            description="Trigger a sim run to evaluate this agent against a suite of scenarios."
            size="lg"
            action={
              <button
                onClick={handleTrigger}
                disabled={triggering}
                className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
              >
                {triggering ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <PlayCircle className="w-4 h-4" />
                )}
                Trigger sim run
              </button>
            }
          />
        </Card>
      )}

      {/* Runs table */}
      {filtered.length > 0 && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                    Run ID
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                    Status
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                    Runner
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                    Started
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                    Duration
                  </th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {filtered.map((r) => (
                  <tr
                    key={r.id}
                    className="hover:bg-[var(--bg-tertiary)]/50 transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-[var(--text-primary)]">
                      {r.id.length > 20 ? `${r.id.slice(0, 20)}…` : r.id}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded",
                          STATUS_BADGE[r.status] ?? STATUS_BADGE.pending,
                        )}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[var(--text-muted)] text-xs font-mono">
                      {r.runner_kind ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-[var(--text-muted)] text-xs">
                      {formatTime(r.started_at)}
                    </td>
                    <td className="px-4 py-3 text-[var(--text-secondary)] text-xs tabular-nums">
                      {formatDuration(r.duration_ms)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/agents/${encodeURIComponent(agentId)}/sim-runs/${r.id}`}
                        className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
                      >
                        Inspect
                        <ChevronRight className="w-3.5 h-3.5" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Filtered out empty */}
      {!loading && runs.length > 0 && filtered.length === 0 && (
        <Card className="p-8">
          <EmptyState
            icon={Search}
            title="No matches"
            description="No sim runs match the current filters."
            size="sm"
            action={
              <button
                onClick={() => {
                  setSearch("");
                  setStatusFilter("");
                }}
                className="text-xs text-[var(--accent)] hover:underline"
              >
                Clear filters
              </button>
            }
          />
        </Card>
      )}
    </div>
  );
}
