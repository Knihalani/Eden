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
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { useToast } from "@/components/ui/toast";
import { ArrowLeft, Database, RefreshCw, Plus } from "lucide-react";
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
  const [error, setError] = useState<string | null>(null);
  const [newRow, setNewRow] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!currentOrg?.id || !id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await datasetsApi.get(currentOrg.id, id);
      setData(res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load dataset";
      setError(msg);
      toast.error(msg);
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
      toast.error(e instanceof Error ? e.message : "Failed to add row");
    } finally {
      setSubmitting(false);
    }
  };

  const colKeys = data?.columns.map((c) => c.id) ?? [];

  return (
    <PageContent size="wide">
      <PageHeader
        eyebrow="Data · Dataset"
        title={data?.name || "Dataset"}
        subtitle={data?.description || (loading ? "Loading…" : "Spreadsheet view of dataset rows.")}
        icon={Database}
        actions={
          <>
            <Link
              href="/datasets"
              aria-label="Back to datasets list"
              className="inline-flex items-center gap-1 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </Link>
            <Button
              onClick={load}
              variant="outline"
              size="sm"
              disabled={loading}
              loading={loading}
              aria-label="Refresh dataset"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </>
        }
      />

      {error && !loading && (
        <ErrorState
          title="Could not load dataset"
          message={error}
          action={
            <Button onClick={load} variant="outline" size="sm" disabled={loading}>
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </Button>
          }
        />
      )}

      {!error && (
        <>
          <Card className="p-4 space-y-3">
            <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Add row</div>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                placeholder='{"key": "value"} or just a string'
                value={newRow}
                onChange={(e) => setNewRow(e.target.value)}
                className="flex-1 font-mono text-xs"
                aria-label="Row JSON or string"
                disabled={submitting}
              />
              <Button
                onClick={addRow}
                disabled={!newRow.trim() || submitting}
                loading={submitting}
              >
                <Plus className="h-3.5 w-3.5" /> Add
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
        </>
      )}
    
    </PageContent>
  );
}