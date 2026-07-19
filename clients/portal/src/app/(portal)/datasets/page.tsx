"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTableSearch } from "@/components/ui/data-table";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/layout/page-header";
import { useToast } from "@/components/ui/toast";
import { Database, ExternalLink, RefreshCw, Loader2, Plus } from "lucide-react";
import { datasetsApi, type Dataset } from "@/lib/api";
import {
  CoreResourcePage,
  InfiniteDataTable,
  ResourceOsToolbar,
  CrossLinkBar,
} from "@/components/portal-os";
import { usePagePerf } from "@/lib/perf";

function DatasetsPageInner() {
  const { currentOrg } = useOrg();
  usePagePerf("/datasets");
  const toast = useToast();
  const searchParams = useSearchParams();
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

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

  useEffect(() => {
    const traceId = searchParams.get("promote_trace");
    if (!traceId || !currentOrg?.id) return;
    void (async () => {
      try {
        const res = await datasetsApi.promoteFromTrace(currentOrg.id, {
          trace_id: traceId,
          dataset_name: `From trace ${traceId.slice(0, 8)}`,
        });
        toast.success("Trace promoted into dataset");
        const dsId = res.data?.dataset_id;
        if (dsId) window.location.href = `/datasets/${dsId}`;
        else await load();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Promote failed");
      }
    })();
  }, [searchParams, currentOrg?.id]);

  if (!currentOrg) return <NoOrgState feature="Datasets" />;

  const createDataset = async () => {
    if (!newName.trim() || !currentOrg?.id) return;
    setCreating(true);
    try {
      const ds = await datasetsApi.create(currentOrg.id, { name: newName.trim() });
      toast.success("Dataset created");
      setNewName("");
      window.location.href = `/datasets/${ds.id}`;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  };

  const filtered = datasets.filter((d) =>
    d.name.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <CoreResourcePage
      size="wide"
      header={
        <PageHeader
          eyebrow="Data"
          title="Datasets"
          subtitle="Spreadsheet edit, import wizard, snapshots, promote-from-trace."
          icon={Database}
          actions={
            <>
              <DataTableSearch
                value={filter}
                onChange={setFilter}
                placeholder="Filter datasets"
              />
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
      }
      toolbar={
        <div className="mb-2 space-y-3">
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="New dataset name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="max-w-xs"
            />
            <Button
              size="sm"
              onClick={createDataset}
              disabled={!newName.trim() || creating}
              loading={creating}
            >
              <Plus className="h-3.5 w-3.5" /> Create
            </Button>
          </div>
          <ResourceOsToolbar
            resourceKey="datasets"
            exportRows={filtered.map((d) => ({
              id: d.id,
              name: d.name,
              row_count: (d as { row_count?: number }).row_count ?? 0,
            }))}
            exportFilename="datasets.csv"
          />
          <CrossLinkBar
            links={[
              { label: "Playgrounds", href: "/evals?tab=playgrounds" },
              { label: "Experiments", href: "/evals?tab=experiments" },
              { label: "Labeling", href: "/evals?tab=labeling" },
              { label: "Issues", href: "/issues" },
            ]}
          />
        </div>
      }
      table={
        error ? (
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
            <InfiniteDataTable
              loading={loading}
              rows={filtered}
              rowKey={(r) => r.id}
              emptyTitle="No datasets"
              emptyDescription="Start the eval loop: resolve an issue → promote traces here → playground → experiment → regression gate."
              emptyIcon={Database}
              emptyAction={
                <div className="flex flex-wrap justify-center gap-2 text-sm">
                  <Link href="/issues" className="text-[var(--accent)] hover:underline">
                    Issues
                  </Link>
                  <span className="text-[var(--text-muted)]">→</span>
                  <Link href="/evals?tab=playgrounds" className="text-[var(--accent)] hover:underline">
                    Playground
                  </Link>
                  <span className="text-[var(--text-muted)]">→</span>
                  <Link href="/evals?tab=experiments" className="text-[var(--accent)] hover:underline">
                    Experiments
                  </Link>
                </div>
              }
              columns={[
                {
                  key: "name",
                  header: "Name",
                  sortable: true,
                  cell: (r) => (
                    <Link
                      href={`/datasets/${r.id}`}
                      className="font-medium text-[var(--accent)] hover:underline"
                    >
                      {r.name}
                    </Link>
                  ),
                },
                { key: "description", header: "Description" },
                { key: "row_count", header: "Rows", align: "right", sortable: true },
                { key: "column_count", header: "Columns", align: "right", sortable: true },
                {
                  key: "created_at",
                  header: "Created",
                  sortable: true,
                  cell: (r) => new Date(r.created_at).toLocaleString(),
                },
                {
                  key: "actions",
                  header: "",
                  align: "right",
                  cell: (r) => (
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
        )
      }
    />
  );
}

export default function DatasetsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
        </div>
      }
    >
      <DatasetsPageInner />
    </Suspense>
  );
}
