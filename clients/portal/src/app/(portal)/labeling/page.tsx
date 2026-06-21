"use client";

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable, DataTableSearch } from "@/components/ui/data-table";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { useToast } from "@/components/ui/toast";
import { Tag, RefreshCw, Plus } from "lucide-react";
import { labelingApi, type LabelingItem } from "@/lib/api";

export default function LabelingPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [items, setItems] = useState<LabelingItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    if (!currentOrg?.id) return;
    setLoading(true);
    try {
      const res = await labelingApi.listItems(currentOrg.id);
      setItems(res.items || []);
    } catch (e) {
      toast.error((e as Error).message || "Failed to load labeling queue");
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id, toast]);

  useEffect(() => {
    load();
  }, [load]);

  if (!currentOrg) return <NoOrgState feature="Labeling queue" />;

  const filtered = items.filter((i) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return i.prompt.toLowerCase().includes(q) || i.tags.some((t) => t.toLowerCase().includes(q));
  });

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Labeling queue"
        subtitle="Items waiting for human labels. Approve or skip — annotations feed the eval pipeline."
        actions={
          <>
            <DataTableSearch value={filter} onChange={setFilter} placeholder="Filter by prompt or tag" />
            <Button onClick={load} variant="outline" size="sm" disabled={loading}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
            <Button size="sm" disabled title="Seed from intake — coming soon">
              <Plus className="h-3.5 w-3.5" /> Seed item
            </Button>
          </>
        }
      />

      <Card className="p-2">
        <DataTable
          loading={loading}
          rows={filtered}
          rowKey={(r) => r.id}
          emptyTitle="No items in queue"
          emptyDescription="When the eval pipeline flags low-confidence items, they appear here for human review."
          columns={[
            { key: "prompt", header: "Prompt", sortable: true, cell: (r) => <span className="font-mono text-xs">{r.prompt.slice(0, 120)}{r.prompt.length > 120 ? "…" : ""}</span> },
            { key: "tags", header: "Tags", cell: (r) => <span className="flex flex-wrap gap-1">{r.tags.map((t) => <Tag key={t} className="text-[10px]">{t}</Tag>)}</span> },
            { key: "source", header: "Source", sortable: true },
            { key: "annotations_count", header: "Annotations", sortable: true, align: "right" },
            { key: "created_at", header: "Created", sortable: true, cell: (r) => new Date(r.created_at).toLocaleString() },
          ]}
        />
      </Card>
    </div>
  );
}
