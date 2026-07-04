"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable, DataTableSearch } from "@/components/ui/data-table";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/layout/page-header";
import { useToast } from "@/components/ui/toast";
import { Database, ExternalLink, RefreshCw } from "lucide-react";
import { datasetsApi, type Dataset } from "@/lib/api";

export default function DatasetsPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    if (!currentOrg?.id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await datasetsApi.list(currentOrg.id);
      setDatasets(res.datasets || []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load datasets";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id, toast]);

  useEffect(() => {
    load();
  }, [load]);

  if (!currentOrg) return <NoOrgState feature="Datasets" />;

  const filtered = datasets.filter((d) => d.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <PageHeader
        eyebrow="Data"
        title="Datasets"
        subtitle="Tabular datasets with AI-fill columns. Click a row to open the spreadsheet view."
        icon={Database}
        actions={
          <>
            <DataTableSearch value={filter} onChange={setFilter} placeholder="Filter datasets" />
            <Button
              onClick={load}
              variant="outline"
              size="sm"
              disabled={loading}
              loading={loading}
              aria-label="Refresh datasets"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </>
        }
      />

      {error ? (
        <ErrorState
          title="Could not load datasets"
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
            emptyTitle="No datasets"
            emptyDescription="Create one with the CLI: `eden datasets create <name>`. They appear here once the row is written."
            emptyIcon={Database}
            columns={[
              { key: "name", header: "Name", sortable: true, cell: (r) => (
                <Link
                  href={`/datasets/${r.id}`}
                  className="font-medium text-[var(--accent)] hover:underline"
                >
                  {r.name}
                </Link>
              ) },
              { key: "description", header: "Description" },
              { key: "row_count", header: "Rows", align: "right", sortable: true },
              { key: "column_count", header: "Columns", align: "right", sortable: true },
              { key: "created_at", header: "Created", sortable: true, cell: (r) => new Date(r.created_at).toLocaleString() },
              {
                key: "actions", header: "", align: "right", cell: (r) => (
                  <Link
                    href={`/datasets/${r.id}`}
                    aria-label={`Open dataset ${r.name}`}
                    className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  >
                    Open <ExternalLink className="h-3 w-3" />
                  </Link>
                ),
              },
            ]}
          />
        </Card>
      )}
    </div>
  );
}