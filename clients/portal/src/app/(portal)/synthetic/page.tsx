"use client";

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { useToast } from "@/components/ui/toast";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { qaApi, type QARun } from "@/lib/api";

export default function SyntheticPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [runs, setRuns] = useState<QARun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [count, setCount] = useState(20);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!currentOrg?.id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await qaApi.listRuns(currentOrg.id);
      setRuns(res.runs || []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load runs";
      setError(msg);
      toast.error(msg);
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
      toast.error(e instanceof Error ? e.message : "Failed to queue generation");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PageContent size="wide">
      <PageHeader
        eyebrow="Eval"
        title="Synthetic Q/A"
        subtitle="Live QA generator (not a stub). Queues synthetic cases for eval datasets."
        icon={Sparkles}
        actions={
          <Button
            onClick={load}
            variant="outline"
            size="sm"
            disabled={loading}
            loading={loading}
            aria-label="Refresh runs"
          >
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
            disabled={submitting}
          />
          <Input
            type="number"
            min={1}
            max={500}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
            className="w-24"
            aria-label="Number of pairs to generate"
            disabled={submitting}
          />
          <Button
            onClick={submit}
            disabled={!topic.trim() || submitting}
            loading={submitting}
            aria-label="Generate synthetic Q/A pairs"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {submitting ? "Queueing…" : "Generate"}
          </Button>
        </div>
      </Card>

      {error ? (
        <ErrorState
          title="Could not load runs"
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
            rows={runs}
            rowKey={(r) => r.id}
            emptyTitle="No runs yet"
            emptyDescription="Submit a topic above to generate your first Q/A dataset."
            emptyIcon={Sparkles}
            columns={[
              { key: "id", header: "Run", cell: (r) => <span className="font-mono text-xs">{r.id}</span> },
              { key: "topic", header: "Topic", sortable: true },
              { key: "count", header: "Count", align: "right", sortable: true },
              { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
              { key: "created_at", header: "Created", sortable: true, cell: (r) => new Date(r.created_at).toLocaleString() },
            ]}
          />
        </Card>
      )}
    
    </PageContent>
  );
}