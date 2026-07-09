"use client";

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable, DataTableSearch } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/layout/page-header";
import { useToast } from "@/components/ui/toast";
import { Activity, Loader2, RefreshCw, Play } from "lucide-react";
import { signalsApi, type Signal } from "@/lib/api";

export default function SignalsPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(false);
  const [compilingId, setCompilingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    if (!currentOrg?.id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await signalsApi.list(currentOrg.id);
      setSignals(res.signals || []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load signals";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id, toast]);

  useEffect(() => {
    load();
  }, [load]);

  if (!currentOrg) return <NoOrgState feature="Signals" />;

  const filtered = signals.filter((s) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return s.name.toLowerCase().includes(q) || s.natural_query.toLowerCase().includes(q);
  });

  const compileSignal = async (signalId: string) => {
    if (!currentOrg?.id) return;
    setCompilingId(signalId);
    try {
      await signalsApi.compile(currentOrg.id, signalId);
      toast.success("Compiled");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Compilation failed");
    } finally {
      setCompilingId(null);
    }
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <PageHeader
        eyebrow="Observability"
        title="Signals"
        subtitle="Plain-English metrics. Each signal is compiled to a SQL query the platform runs on telemetry."
        icon={Activity}
        actions={
          <>
            <DataTableSearch value={filter} onChange={setFilter} placeholder="Filter signals" />
            <Button
              onClick={load}
              variant="outline"
              size="sm"
              disabled={loading}
              loading={loading}
              aria-label="Refresh signals"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </>
        }
      />

      {error ? (
        <ErrorState
          title="Could not load signals"
          message={error}
          action={
            <Button onClick={load} variant="outline" size="sm" disabled={loading}>
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </Button>
          }
        />
      ) : (
        <Card className="p-2">
          <DataTable
            loading={loading}
            rows={filtered}
            rowKey={(r) => r.id}
            emptyTitle="No signals yet"
            emptyDescription="Create a signal from the CLI: `eden signals add` — they'll appear here once compiled."
            emptyIcon={Activity}
            emptyVariant="terminal"
            emptyTerminal={
              <div className="rounded-lg overflow-hidden border border-[var(--border-default)] bg-[var(--bg-base)] text-left shadow-[0_24px_60px_-24px_rgba(0,0,0,0.6)]">
                <div className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)]">
                  <span className="w-2 h-2 rounded-full bg-[var(--traffic-close)]" />
                  <span className="w-2 h-2 rounded-full bg-[var(--traffic-minimize)]" />
                  <span className="w-2 h-2 rounded-full bg-[var(--traffic-zoom)]" />
                  <span className="ml-2 text-[10px] font-mono text-[var(--text-muted)] tracking-wider">
                    signal.preview
                  </span>
                  <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--terminal)]">
                    <span className="w-1 h-1 rounded-full bg-[var(--terminal)]" />
                    compiled
                  </span>
                </div>
                <div className="p-4 space-y-2 font-mono text-xs">
                  <div className="flex items-center gap-2 text-[var(--text-muted)]">
                    <span className="text-[var(--accent)]">$</span>
                    <span>eden signals add &quot;p95 latency by tool&quot;</span>
                  </div>
                  <div className="pl-4 text-[var(--text-secondary)]">
                    → sql/tools/p95_latency_by_tool.sql
                  </div>
                  <div className="pl-4 text-[var(--terminal)]">
                    ✓ compiled · 142 traces · last run 3m ago
                  </div>
                </div>
              </div>
            }
            columns={[
              { key: "name", header: "Name", sortable: true },
              { key: "description", header: "Description" },
              {
                key: "natural_query",
                header: "Query",
                cell: (r) => (
                  <span className="font-mono text-xs text-[var(--text-muted)]">{r.natural_query}</span>
                ),
              },
              { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
              {
                key: "actions",
                header: "",
                align: "right",
                cell: (r) => {
                  const isCompiling = compilingId === r.id;
                  return (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={r.status === "active" || isCompiling}
                      loading={isCompiling}
                      onClick={() => compileSignal(r.id)}
                      aria-label={`Compile signal ${r.name}`}
                    >
                      {isCompiling ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Play className="h-3 w-3" />
                      )}
                      Compile
                    </Button>
                  );
                },
              },
            ]}
          />
        </Card>
      )}
    </div>
  );
}