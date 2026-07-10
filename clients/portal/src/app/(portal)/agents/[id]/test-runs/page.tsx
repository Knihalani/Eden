"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { agentsApi, type SimRun } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { useToast } from "@/components/ui/toast";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  ArrowLeft,
  ChevronRight,
  Filter,
  Loader2,
  PlayCircle,
  RefreshCw,
  Search,
  TestTube2,
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

export default function TestRunsPage() {
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
      const data = await agentsApi.listTestRuns(currentOrg.id, agentId, { limit: 50 });
      setRuns(data.runs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load test runs");
    } finally {
      setLoading(false);
    }
  }, [currentOrg, agentId]);

  useEffect(() => {
     
    if (currentOrg) load();
  }, [currentOrg, load]);

  async function handleTrigger() {
    if (!currentOrg) return;
    setTriggering(true);
    try {
      await agentsApi.triggerTestRun(currentOrg.id, agentId, {});
      toast.success("Test run triggered");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to trigger test run");
    } finally {
      setTriggering(false);
    }
  }

  const filtered = runs.filter((r) => {
    if (statusFilter && r.status !== statusFilter) return false;
    if (search && !r.id.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const columns: DataTableColumn<SimRun>[] = [
    {
      key: "id",
      header: "Run ID",
      sortable: true,
      cell: (r) => (
        <span className="font-mono text-xs text-[var(--text-primary)]">
          {r.id.length > 20 ? `${r.id.slice(0, 20)}…` : r.id}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      cell: (r) => (
        <span
          className={cn(
            "text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded",
            STATUS_BADGE[r.status] ?? STATUS_BADGE.pending,
          )}
        >
          {r.status}
        </span>
      ),
    },
    {
      key: "runner_kind",
      header: "Runner",
      sortable: true,
      cell: (r) => (
        <span className="text-[var(--text-muted)] text-xs font-mono">{r.runner_kind ?? "—"}</span>
      ),
    },
    {
      key: "started_at",
      header: "Started",
      sortable: true,
      cell: (r) => (
        <span className="text-[var(--text-muted)] text-xs">{formatTime(r.started_at)}</span>
      ),
    },
    {
      key: "duration_ms",
      header: "Duration",
      sortable: true,
      align: "right",
      cell: (r) => (
        <span className="text-[var(--text-secondary)] text-xs tabular-nums">
          {formatDuration(r.duration_ms)}
        </span>
      ),
    },
    {
      key: "id_link",
      header: "",
      align: "right",
      cell: (r) => (
        <Link
          href={`/agents/${encodeURIComponent(agentId)}/test-runs/${r.id}`}
          className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
        >
          Inspect
          <ChevronRight className="w-3.5 h-3.5" />
        </Link>
      ),
    },
  ];

  if (!currentOrg) {
    return (
      <NoOrgState
        icon={TestTube2}
        feature="Test runs"
        description="Trigger and inspect test runs for this agent."
      />
    );
  }

  return (
    <PageContent size="wide">
      <div>
        <Link
          href={`/agents/${encodeURIComponent(agentId)}`}
          className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
        >
          <ArrowLeft className="w-3 h-3" />
          Back to agent
        </Link>
      </div>

      <PageHeader
        eyebrow="Agent"
        title="Test runs"
        icon={TestTube2}
        subtitle={
          <>
            <span className="font-mono">{agentId}</span>
            {" · "}
            {runs.length} run{runs.length === 1 ? "" : "s"}
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              aria-label="Refresh test runs"
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-sm font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
              Refresh
            </button>
            <button
              type="button"
              onClick={handleTrigger}
              disabled={triggering}
              aria-label="Trigger a new test run"
              className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
            >
              {triggering ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <PlayCircle className="w-4 h-4" />
              )}
              Trigger test run
            </button>
          </div>
        }
      />

      {error && (
        <ErrorState
          title="Could not load test runs"
          message={error}
          size="sm"
          action={
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex items-center gap-2 px-3 py-1.5 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-xs font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              Try again
            </button>
          }
        />
      )}

      {runs.length > 0 && (
        <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by run id…"
              aria-label="Search test runs by run id"
              className="w-full pl-9 pr-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
            />
          </div>
          <div className="relative">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)] pointer-events-none" />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              aria-label="Filter test runs by status"
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

      {loading && runs.length === 0 && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
        </div>
      )}

      {!loading && runs.length === 0 && (
        <Card className="p-8">
          <EmptyState
            icon={TestTube2}
            title="No test runs yet"
            description="Trigger a test run to execute this agent's tests."
            size="lg"
            action={
              <button
                type="button"
                onClick={handleTrigger}
                disabled={triggering}
                aria-label="Trigger a new test run"
                className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
              >
                {triggering ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <PlayCircle className="w-4 h-4" />
                )}
                Trigger test run
              </button>
            }
          />
        </Card>
      )}

      {filtered.length > 0 && (
        <Card className="overflow-hidden">
          <DataTable
            columns={columns}
            rows={filtered}
            rowKey={(r) => r.id}
            loading={loading}
            defaultSort={{ key: "started_at", direction: "desc" }}
            pageSize={25}
          />
        </Card>
      )}

      {!loading && runs.length > 0 && filtered.length === 0 && (
        <Card className="p-8">
          <EmptyState
            icon={Search}
            title="No matches"
            description="No test runs match the current filters."
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
    
    </PageContent>
  );
}
