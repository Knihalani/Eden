"use client";

import { useState } from "react";
import { useOrg } from "@/hooks/use-org";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import { PageContent } from "@/components/layout/page-content";
import { ObserveLeafHeader } from "@/app/(portal)/observability/_components/observe-leaf-shell";
import { Database, Play, Layers, RefreshCw, Archive, FileText } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { STICKY_FIRST_TD, STICKY_FIRST_TH } from "@/components/ui/table-sticky";
import { errorFromCaught } from "@/lib/safe-error-message";
interface ColumnarQueryResult {
  status: string;
  message?: string;
  data: {
    rows: Array<Record<string, unknown>>;
    n_rows: number;
    data_source: string;
  } | null;
}
interface PartitionsResult {
  period: string;
  partitions_ensured: number;
}
interface RollupsResult {
  rollups_computed: number;
  period: string;
}
interface CompactResult {
  compacted: number;
  compacted_size_bytes: number;
  duration_ms: number;
}
async function columnarQuery(orgId: string, sql: string): Promise<ColumnarQueryResult> {
  return api.post<ColumnarQueryResult>(`/orgs/${orgId}/intelligence/columnar/query`, { query: sql });
}
async function ensurePartitions(orgId: string, period: string): Promise<PartitionsResult> {
  return api.post<PartitionsResult>(`/orgs/${orgId}/intelligence/columnar/partitions/ensure`, { period });
}
async function precomputeRollups(orgId: string): Promise<RollupsResult> {
  return api.post<RollupsResult>(`/orgs/${orgId}/intelligence/columnar/rollups/precompute`, {});
}
async function compactColumnar(orgId: string): Promise<CompactResult> {
  return api.post<CompactResult>(`/orgs/${orgId}/intelligence/columnar/compact`, {});
}
const DEFAULT_SQL = `SELECT
  event_type,
  count() AS n,
  avg(duration_ms) AS avg_ms
FROM usage_events
WHERE ts >= now() - interval '7 day'
GROUP BY event_type
ORDER BY n DESC
LIMIT 50;`;
export default function CohortsPage() {
  const {
    currentOrg
  } = useOrg();
  const toast = useToast();
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [running, setRunning] = useState(false);
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [dataSource, setDataSource] = useState<string>("");
  const [error, setError] = useState("");

  // Action button busy state (per-action so multiple can run in parallel)
  const [actionBusy, setActionBusy] = useState<{
    partitions: boolean;
    rollups: boolean;
    compact: boolean;
  }>({
    partitions: false,
    rollups: false,
    compact: false
  });
  async function runQuery() {
    if (!currentOrg) return;
    if (!sql.trim()) {
      setError("SQL query cannot be empty");
      return;
    }
    setRunning(true);
    setError("");
    try {
      const res = await columnarQuery(currentOrg.id, sql);
      if ((res.status !== "ok" && res.status !== "ok_fallback") || !res.data) {
        setError(res.message?.trim() || `Query returned status "${res.status}"`);
        setColumns([]);
        setRows([]);
        return;
      }
      const dictRows = res.data.rows ?? [];
      setColumns(dictRows.length > 0 ? Object.keys(dictRows[0]!) : []);
      setRows(dictRows);
      setDataSource(res.data.data_source);
    } catch (err) {
      setError(errorFromCaught(err, "Query failed"));
      setColumns([]);
      setRows([]);
    } finally {
      setRunning(false);
    }
  }
  async function handleEnsurePartitions() {
    if (!currentOrg) return;
    setActionBusy(s => ({
      ...s,
      partitions: true
    }));
    try {
      const res = await ensurePartitions(currentOrg.id, "monthly");
      toast.success(`Partitions ensured — ${res.partitions_ensured} (${res.period})`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to ensure partitions");
    } finally {
      setActionBusy(s => ({
        ...s,
        partitions: false
      }));
    }
  }
  async function handlePrecomputeRollups() {
    if (!currentOrg) return;
    setActionBusy(s => ({
      ...s,
      rollups: true
    }));
    try {
      const res = await precomputeRollups(currentOrg.id);
      toast.success(`Rollups computed — ${res.rollups_computed} (${res.period})`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to precompute rollups");
    } finally {
      setActionBusy(s => ({
        ...s,
        rollups: false
      }));
    }
  }
  async function handleCompact() {
    if (!currentOrg) return;
    setActionBusy(s => ({
      ...s,
      compact: true
    }));
    try {
      const res = await compactColumnar(currentOrg.id);
      const kb = (res.compacted_size_bytes / 1024).toFixed(1);
      toast.success(`Compacted ${res.compacted} parts (${kb} KB) in ${res.duration_ms.toFixed(0)}ms`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to compact");
    } finally {
      setActionBusy(s => ({
        ...s,
        compact: false
      }));
    }
  }
  if (!currentOrg) {
    return <NoOrgState icon={Database} feature="Columnar Engine" description="Run read-only SQL across ClickHouse partitions and precomputed rollups once your org is configured." />;
  }
  return <PageContent size="wide">
      <ObserveLeafHeader title="Columnar Engine" subtitle="Read-only SQL across per-org monthly partitions with hourly / daily / weekly rollups" icon={Database} />

      {/* Maintenance actions */}
      <Card padding="md">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
          <Layers className="w-4 h-4 text-[var(--accent)]" />
          Maintenance
        </h3>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" className="min-h-11" onClick={handleEnsurePartitions} loading={actionBusy.partitions}>
            <Layers className="w-4 h-4" />
            Ensure partitions
          </Button>
          <Button variant="secondary" size="sm" className="min-h-11" onClick={handlePrecomputeRollups} loading={actionBusy.rollups}>
            <RefreshCw className="w-4 h-4" />
            Precompute rollups
          </Button>
          <Button variant="secondary" size="sm" className="min-h-11" onClick={handleCompact} loading={actionBusy.compact}>
            <Archive className="w-4 h-4" />
            Compact
          </Button>
        </div>
      </Card>

      {error ? (
        <ErrorState
          title="Query failed"
          message={error}
          action={
            <Button size="sm" variant="outline" onClick={() => void runQuery()}>
              Try again
            </Button>
          }
        />
      ) : null}

      {/* SQL editor */}
      <Card padding="md" className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <FileText className="w-4 h-4 text-[var(--accent)]" />
            SQL Query
          </h3>
          <div className="flex items-center gap-2">
            {dataSource && <span className={cn("text-2xs uppercase tracking-wide px-2 py-0.5 rounded-full font-medium", dataSource === "clickhouse" ? "bg-[var(--accent-faint)] text-[var(--accent)]" : "bg-[var(--warning-bg)] text-[var(--warning)]")}>
                {dataSource === "clickhouse" ? "clickhouse" : "postgres_fallback"}
              </span>}
            <Button variant="default" className="min-h-11" onClick={runQuery} loading={running}>
            <Play className="w-4 h-4" />
            Run
          </Button>
          </div>
        </div>
        <textarea value={sql} onChange={e => setSql(e.target.value)} spellCheck={false} className="w-full min-h-[180px] px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]" placeholder="SELECT … FROM usage_events …" />
        <p className="text-xs text-[var(--text-muted)]">
          Read-only SQL. DROP/DELETE/INSERT/UPDATE not allowed.
        </p>
      </Card>

      {/* Results */}
      {running ? (
        <div className="space-y-3 py-6" aria-busy="true" aria-live="polite">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ) : rows.length > 0 ? (
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
          <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] flex items-center justify-between">
            <span className="text-xs text-[var(--text-muted)]">
              {rows.length} row{rows.length === 1 ? "" : "s"} · {columns.length} column{columns.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
                  {columns.map((c, colIdx) => (
                    <th
                      key={c}
                      className={cn(
                        "text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide whitespace-nowrap",
                        colIdx === 0 && STICKY_FIRST_TH,
                      )}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {rows.map((row, idx) => (
                  <tr key={idx} className="hover:bg-[var(--bg-tertiary)]/50 transition-colors">
                    {columns.map((c, colIdx) => {
                      const cell = row[c];
                      return (
                        <td
                          key={c}
                          className={cn(
                            "px-4 py-2.5 text-[var(--text-secondary)] font-mono text-xs whitespace-nowrap",
                            colIdx === 0 && STICKY_FIRST_TD,
                          )}
                        >
                          {cell === null || cell === undefined ? (
                            <span className="text-[var(--text-muted)]">null</span>
                          ) : (
                            String(cell)
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <Card padding="lg" className="py-10 text-center">
          <Database className="w-10 h-10 mx-auto mb-2 text-[var(--text-muted)] opacity-40" />
          <p className="text-sm text-[var(--text-muted)]">No results yet. Click Run to execute your query.</p>
        </Card>
      )}
    </PageContent>;
}