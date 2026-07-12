"use client";

import { useState } from "react";
import { useOrg } from "@/hooks/use-org";
import { cn } from "@/lib/utils";
import { API_BASE } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { Database, Play, Layers, RefreshCw, Loader2, AlertTriangle, Archive, FileText } from "lucide-react";
import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { errorFromCaught } from "@/lib/safe-error-message";
interface ColumnarQueryResult {
  columns: string[];
  rows: Array<Array<unknown>>;
  row_count: number;
  data_source: string;
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
async function fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json"
    },
    ...init
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({
      detail: "Request failed"
    }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}
async function columnarQuery(orgId: string, sql: string): Promise<ColumnarQueryResult> {
  return fetchJson<ColumnarQueryResult>(`/orgs/${orgId}/intelligence/columnar/query`, {
    method: "POST",
    body: JSON.stringify({
      sql
    })
  });
}
async function ensurePartitions(orgId: string, period: string): Promise<PartitionsResult> {
  return fetchJson<PartitionsResult>(`/orgs/${orgId}/intelligence/columnar/partitions/ensure`, {
    method: "POST",
    body: JSON.stringify({
      period
    })
  });
}
async function precomputeRollups(orgId: string): Promise<RollupsResult> {
  return fetchJson<RollupsResult>(`/orgs/${orgId}/intelligence/columnar/rollups/precompute`, {
    method: "POST"
  });
}
async function compactColumnar(orgId: string): Promise<CompactResult> {
  return fetchJson<CompactResult>(`/orgs/${orgId}/intelligence/columnar/compact`, {
    method: "POST"
  });
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
  const [rows, setRows] = useState<Array<Array<unknown>>>([]);
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
      setColumns(res.columns);
      setRows(res.rows);
      setDataSource(res.data_source);
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
      <PageHeader title="Columnar Engine" subtitle="Read-only SQL across per-org monthly partitions with hourly / daily / weekly rollups" icon={Database} eyebrow="Observe" />

      {/* Maintenance actions */}
      <Card padding="md">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
          <Layers className="w-4 h-4 text-[var(--accent)]" />
          Maintenance
        </h3>
        <div className="flex flex-wrap gap-2">
          <button onClick={handleEnsurePartitions} disabled={actionBusy.partitions} className="inline-flex items-center gap-2 px-3 py-2 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-sm font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors">
            {actionBusy.partitions ? <Loader2 className="w-4 h-4 animate-spin" /> : <Layers className="w-4 h-4" />}
            Ensure partitions
          </button>
          <button onClick={handlePrecomputeRollups} disabled={actionBusy.rollups} className="inline-flex items-center gap-2 px-3 py-2 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-sm font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors">
            {actionBusy.rollups ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Precompute rollups
          </button>
          <button onClick={handleCompact} disabled={actionBusy.compact} className="inline-flex items-center gap-2 px-3 py-2 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-sm font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors">
            {actionBusy.compact ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />}
            Compact
          </button>
        </div>
      </Card>

      {error && <div className="bg-[var(--error-bg)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--error)]/20">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>}

      {/* SQL editor */}
      <Card padding="md" className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <FileText className="w-4 h-4 text-[var(--accent)]" />
            SQL Query
          </h3>
          <div className="flex items-center gap-2">
            {dataSource && <span className={cn("text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full font-medium", dataSource === "clickhouse" ? "bg-[var(--accent-faint)] text-[var(--accent)]" : "bg-[var(--warning-bg)] text-[var(--warning)]")}>
                {dataSource === "clickhouse" ? "clickhouse" : "postgres_fallback"}
              </span>}
            <button onClick={runQuery} disabled={running} className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors">
              {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              Run
            </button>
          </div>
        </div>
        <textarea value={sql} onChange={e => setSql(e.target.value)} spellCheck={false} className="w-full min-h-[180px] px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]" placeholder="SELECT … FROM usage_events …" />
        <p className="text-[11px] text-[var(--text-muted)]">
          Read-only SQL. DROP/DELETE/INSERT/UPDATE not allowed.
        </p>
      </Card>

      {/* Results */}
      {running ? <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div> : rows.length > 0 ? <motion.div initial={{
      opacity: 0,
      y: 8
    }} animate={{
      opacity: 1,
      y: 0
    }} transition={{
      duration: 0.2
    }} className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
          <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] flex items-center justify-between">
            <span className="text-xs text-[var(--text-muted)]">
              {rows.length} row{rows.length === 1 ? "" : "s"} · {columns.length} column{columns.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
                  {columns.map(c => <th key={c} className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide whitespace-nowrap">
                      {c}
                    </th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {rows.map((row, idx) => <tr key={idx} className="hover:bg-[var(--bg-tertiary)]/50 transition-colors">
                    {row.map((cell, ci) => <td key={ci} className="px-4 py-2.5 text-[var(--text-secondary)] font-mono text-xs whitespace-nowrap">
                        {cell === null || cell === undefined ? <span className="text-[var(--text-muted)]">null</span> : String(cell)}
                      </td>)}
                  </tr>)}
              </tbody>
            </table>
          </div>
        </motion.div> : <Card padding="lg" className="py-10 text-center">
          <Database className="w-10 h-10 mx-auto mb-2 text-[var(--text-muted)] opacity-40" />
          <p className="text-sm text-[var(--text-muted)]">No results yet. Click Run to execute your query.</p>
        </Card>}
    </PageContent>;
}