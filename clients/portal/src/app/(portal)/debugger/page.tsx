"use client";

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable, DataTableSearch } from "@/components/ui/data-table";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { useToast } from "@/components/ui/toast";
import { RefreshCw, Rewind } from "lucide-react";
import { debuggerApi, type Checkpoint } from "@/lib/api";

export default function DebuggerPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    if (!currentOrg?.id) return;
    setLoading(true);
    try {
      const res = await debuggerApi.listCheckpoints(currentOrg.id);
      setCheckpoints(res.checkpoints || []);
    } catch (e) {
      toast.error((e as Error).message || "Failed to load checkpoints");
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id, toast]);

  useEffect(() => {
    load();
  }, [load]);

  if (!currentOrg) return <NoOrgState feature="Debugger" />;

  const filtered = checkpoints.filter((c) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return c.label.toLowerCase().includes(q) || c.trace_id.toLowerCase().includes(q);
  });

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Agent debugger"
        subtitle="Time-travel checkpoints. Rewind a trace to a saved state and replay from there."
        actions={
          <>
            <DataTableSearch value={filter} onChange={setFilter} placeholder="Filter by trace or label" />
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
          emptyTitle="No checkpoints"
          emptyDescription="Checkpoints are created automatically by the agent runtime at every step. They enable non-destructive rewind."
          columns={[
            { key: "label", header: "Label", sortable: true },
            { key: "trace_id", header: "Trace", cell: (r) => <span className="font-mono text-xs">{r.trace_id}</span> },
            { key: "step_index", header: "Step", align: "right", sortable: true },
            { key: "payload_keys", header: "Payload keys", cell: (r) => <span className="text-xs text-[var(--text-muted)]">{r.payload_keys.join(", ") || "—"}</span> },
            { key: "created_at", header: "Created", sortable: true, cell: (r) => new Date(r.created_at).toLocaleString() },
            {
              key: "actions", header: "", align: "right", cell: (r) => (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await debuggerApi.rewind(currentOrg.id, r.id);
                      toast.success(`Rewound to step ${r.step_index}`);
                    } catch (e) {
                      toast.error((e as Error).message);
                    }
                  }}
                >
                  <Rewind className="h-3 w-3" /> Rewind
                </Button>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
