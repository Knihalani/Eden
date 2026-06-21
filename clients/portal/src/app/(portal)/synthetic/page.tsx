"use client";

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { useToast } from "@/components/ui/toast";
import { RefreshCw, Sparkles } from "lucide-react";
import { qaApi, type QARun } from "@/lib/api";

export default function SyntheticPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [runs, setRuns] = useState<QARun[]>([]);
  const [loading, setLoading] = useState(false);
  const [topic, setTopic] = useState("");
  const [count, setCount] = useState(20);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!currentOrg?.id) return;
    setLoading(true);
    try {
      const res = await qaApi.listRuns(currentOrg.id);
      setRuns(res.runs || []);
    } catch (e) {
      toast.error((e as Error).message || "Failed to load runs");
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id, toast]);

  useEffect(() => {
    load();
  }, [load]);

  if (!currentOrg) return <NoOrgState feature="Synthetic Q/A" />;

  const submit = async () => {
    if (!topic.trim() || !currentOrg?.id) return;
    setSubmitting(true);
    try {
      await qaApi.generate(currentOrg.id, { topic: topic.trim(), count });
      toast.success("Generation queued");
      setTopic("");
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Synthetic Q/A"
        subtitle="Generate Q/A pairs for a topic to expand your eval suite. Each run produces a new dataset row group."
        actions={
          <Button onClick={load} variant="outline" size="sm" disabled={loading}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        }
      />

      <Card className="p-4">
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            placeholder="Topic (e.g. 'refund policy edge cases')"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            className="flex-1"
            aria-label="Generation topic"
          />
          <Input
            type="number"
            min={1}
            max={500}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
            className="w-24"
            aria-label="Number of pairs to generate"
          />
          <Button onClick={submit} disabled={!topic.trim() || submitting}>
            <Sparkles className="h-3.5 w-3.5" /> {submitting ? "Queueing…" : "Generate"}
          </Button>
        </div>
      </Card>

      <Card className="p-2">
        <DataTable
          loading={loading}
          rows={runs}
          rowKey={(r) => r.id}
          emptyTitle="No runs yet"
          emptyDescription="Submit a topic above to generate your first Q/A dataset."
          columns={[
            { key: "id", header: "Run", cell: (r) => <span className="font-mono text-xs">{r.id}</span> },
            { key: "topic", header: "Topic", sortable: true },
            { key: "count", header: "Count", align: "right", sortable: true },
            { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
            { key: "created_at", header: "Created", sortable: true, cell: (r) => new Date(r.created_at).toLocaleString() },
          ]}
        />
      </Card>
    </div>
  );
}
