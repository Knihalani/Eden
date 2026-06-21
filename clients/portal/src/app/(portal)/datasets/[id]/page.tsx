"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/ui/data-table";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { useToast } from "@/components/ui/toast";
import { ArrowLeft, RefreshCw, Plus, Sparkles } from "lucide-react";
import { datasetsApi, type DatasetRow, type DatasetColumn } from "@/lib/api";

interface DatasetDetail {
  id: string;
  name: string;
  description?: string;
  columns: DatasetColumn[];
  rows: DatasetRow[];
}

export default function DatasetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [data, setData] = useState<DatasetDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [newRow, setNewRow] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [aiColName, setAiColName] = useState("");
  const [aiColPrompt, setAiColPrompt] = useState("");

  const load = useCallback(async () => {
    if (!currentOrg?.id || !id) return;
    setLoading(true);
    try {
      const res = await datasetsApi.get(currentOrg.id, id);
      setData(res);
    } catch (e) {
      toast.error((e as Error).message || "Failed to load dataset");
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id, id, toast]);

  useEffect(() => {
    load();
  }, [load]);

  if (!currentOrg) return <NoOrgState feature="Dataset" />;

  const addRow = async () => {
    if (!newRow.trim() || !currentOrg?.id || !id) return;
    setSubmitting(true);
    try {
      let values: Record<string, unknown> = {};
      try { values = JSON.parse(newRow); } catch { values = { value: newRow.trim() }; }
      await datasetsApi.addRow(currentOrg.id, id, values);
      toast.success("Row added");
      setNewRow("");
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const generateColumn = async () => {
    if (!aiColName.trim() || !aiColPrompt.trim() || !currentOrg?.id || !id) return;
    setSubmitting(true);
    try {
      await datasetsApi.generateColumn(currentOrg.id, id, { name: aiColName.trim(), kind: "ai_fill", description: aiColPrompt.trim() });
      toast.success("AI column generated");
      setAiColName("");
      setAiColPrompt("");
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const colKeys = data?.columns.map((c) => c.id) ?? [];

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <PageHeader
        title={data?.name || "Dataset"}
        subtitle={data?.description || ""}
        actions={
          <>
            <Link href="/datasets" className="inline-flex items-center gap-1 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]">
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </Link>
            <Button onClick={load} variant="outline" size="sm" disabled={loading}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </>
        }
      />

      <Card className="p-4 space-y-3">
        <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Add row</div>
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            placeholder='{"key": "value"} or just a string'
            value={newRow}
            onChange={(e) => setNewRow(e.target.value)}
            className="flex-1 font-mono text-xs"
            aria-label="Row JSON or string"
          />
          <Button onClick={addRow} disabled={!newRow.trim() || submitting}>
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </div>
      </Card>

      <Card className="p-4 space-y-3">
        <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">AI-fill column</div>
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            placeholder="Column name"
            value={aiColName}
            onChange={(e) => setAiColName(e.target.value)}
            className="w-40"
            aria-label="AI column name"
          />
          <Input
            placeholder="What should this column contain?"
            value={aiColPrompt}
            onChange={(e) => setAiColPrompt(e.target.value)}
            className="flex-1"
            aria-label="AI column prompt"
          />
          <Button onClick={generateColumn} disabled={!aiColName.trim() || !aiColPrompt.trim() || submitting}>
            <Sparkles className="h-3.5 w-3.5" /> Generate
          </Button>
        </div>
      </Card>

      <Card className="p-2">
        <DataTable
          loading={loading}
          rows={data?.rows ?? []}
          rowKey={(r) => r.id}
          emptyTitle="No rows"
          emptyDescription="Use the form above to add a row, or import via CLI."
          columns={[
            ...colKeys.map((k) => ({
              key: `v.${k}`,
              header: k,
              cell: (r: DatasetRow) => <span className="font-mono text-xs">{String(r.values?.[k] ?? "—")}</span>,
            })),
            { key: "created_at", header: "Created", cell: (r) => new Date(r.created_at).toLocaleString() },
          ]}
        />
      </Card>
    </div>
  );
}
