"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTableSearch } from "@/components/ui/data-table";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { useToast } from "@/components/ui/toast";
import { Database, ExternalLink, RefreshCw, Loader2, Plus, ChevronDown } from "lucide-react";
import { datasetsApi, type Dataset } from "@/lib/api";
import {
  CoreResourcePage,
  InfiniteDataTable,
  ResourceOsToolbar,
} from "@/components/portal-os";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { usePagePerf } from "@/lib/perf";

function DatasetsPageInner() {
  const { currentOrg } = useOrg();
  usePagePerf("/datasets");
  const toast = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const nameInputRef = useRef<HTMLInputElement>(null);
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
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id]);

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
        if (dsId) router.push(`/datasets/${dsId}`);
        else await load();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Promote failed");
      }
    })();
  }, [searchParams, currentOrg?.id, load, router, toast]);

  if (!currentOrg) return <NoOrgState feature="Datasets" />;

  const createDataset = async () => {
    if (!newName.trim() || !currentOrg?.id) return;
    setCreating(true);
    try {
      const ds = await datasetsApi.create(currentOrg.id, { name: newName.trim() });
      toast.success("Dataset created");
      setNewName("");
      router.push(`/datasets/${ds.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  };

  const filtered = datasets.filter((d) =>
    d.name.toLowerCase().includes(filter.toLowerCase()),
  );
  const filterActive = Boolean(filter.trim());
  const filterMiss =
    filterActive && !loading && !error && datasets.length > 0 && filtered.length === 0;

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
        <div className="flex flex-col gap-space-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex min-w-0 flex-1 flex-wrap gap-2">
            <Input
              ref={nameInputRef}
              placeholder="New dataset name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="max-w-xs min-h-11"
              onKeyDown={(e) => {
                if (e.key === "Enter") void createDataset();
              }}
            />
            <Button
              className="min-h-11"
              onClick={createDataset}
              disabled={!newName.trim() || creating}
              loading={creating}
            >
              <Plus className="h-3.5 w-3.5" /> Create
            </Button>
          </div>
          <div className="hidden items-center gap-2 sm:flex">
            <ResourceOsToolbar
              resourceKey="datasets"
              exportRows={filtered.map((d) => ({
                id: d.id,
                name: d.name,
                row_count: (d as { row_count?: number }).row_count ?? 0,
              }))}
              exportFilename="datasets.csv"
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="min-h-11" aria-label="Related eval surfaces">
                  Go to
                  <ChevronDown className="h-4 w-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Evaluate path</DropdownMenuLabel>
                <DropdownMenuItem asChild>
                  <Link href="/evals?tab=playgrounds">Playgrounds</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/evals?tab=experiments">Experiments</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/evals?tab=labeling">Labeling</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/issues">Issues</Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      }
      table={
        <QueryState
          loading={loading && datasets.length === 0}
          error={error ? new Error(error) : null}
          data={datasets}
          onRetry={load}
          errorTitle="Could not load datasets"
          isEmpty={() => filtered.length === 0}
          filtersActive={filterActive}
          emptyKind={filterMiss ? "filter-empty" : "zero-data"}
          filterEmptySlot={
            <EmptyState
              icon={Database}
              title="No matching datasets"
              description={`Nothing matches “${filter.trim()}”. Clear the filter or create a new dataset.`}
              variant="plain"
              action={
                <Button
                  className="min-h-11"
                  variant="outline"
                  data-testid="datasets-clear-filter"
                  onClick={() => setFilter("")}
                >
                  Clear filter
                </Button>
              }
            />
          }
          emptySlot={
            <EmptyState
              icon={Database}
              title="No datasets"
              description="No datasets yet. Create one to score agent output, then open Playground."
              variant="plain"
              action={
                <div className="flex flex-wrap items-center justify-center gap-3 text-sm">
                  <Button
                    className="min-h-11"
                    data-testid="datasets-empty-create"
                    onClick={() => nameInputRef.current?.focus()}
                  >
                    <Plus className="h-3.5 w-3.5" /> Create dataset
                  </Button>
                </div>
              }
            />
          }
        >
          {() => (
            <div className="min-w-0 border-y border-[var(--border-subtle)] py-space-2">
              <InfiniteDataTable
                loading={loading}
                rows={filtered}
                rowKey={(r) => r.id}
                emptyTitle="No datasets"
                emptyDescription="No datasets yet."
                emptyIcon={Database}
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
            </div>
          )}
        </QueryState>
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
