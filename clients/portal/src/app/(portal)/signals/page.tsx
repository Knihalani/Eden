"use client";

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable, DataTableSearch } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { useToast } from "@/components/ui/toast";
import { RefreshCw, Play } from "lucide-react";
import { signalsApi, type Signal } from "@/lib/api";

export default function SignalsPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    if (!currentOrg?.id) return;
    setLoading(true);
    try {
      const res = await signalsApi.list(currentOrg.id);
      setSignals(res.signals || []);
    } catch (e) {
      toast.error((e as Error).message || "Failed to load signals");
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

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Signals"
        subtitle="Plain-English metrics. Each signal is compiled to a SQL query the platform runs on telemetry."
        actions={
          <>
            <DataTableSearch value={filter} onChange={setFilter} placeholder="Filter signals" />
            <Button onClick={load} variant="outline" size="sm" disabled={loading}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </>
        }
      />

      <Card className="p-2">
        <DataTable
          loading={loading}
          rows={filtered}
          rowKey={(r) => r.id}
          emptyTitle="No signals yet"
          emptyDescription="Create a signal from the CLI: `eden signals add` — they'll appear here once compiled."
          columns={[
            { key: "name", header: "Name", sortable: true },
            { key: "description", header: "Description" },
            { key: "natural_query", header: "Query", cell: (r) => <span className="font-mono text-xs text-[var(--text-muted)]">{r.natural_query}</span> },
            { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
            {
              key: "actions", header: "", align: "right", cell: (r) => (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={r.status === "active"}
                  onClick={async () => {
                    try {
                      await signalsApi.compile(currentOrg.id, r.id);
                      toast.success("Compiled");
                      load();
                    } catch (e) {
                      toast.error((e as Error).message);
                    }
                  }}
                >
                  <Play className="h-3 w-3" /> Compile
                </Button>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
