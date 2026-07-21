"use client";

import { Suspense } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { Database, ExternalLink, Loader2, Plus, RefreshCw } from "lucide-react";
import { CoreResourcePage, ResourceOsToolbar } from "@/components/portal-os";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { useDatasetsPage } from "./_components/use-datasets-page";
import { DatasetsCreateStrip } from "./_components/datasets-toolbar";
import { DatasetsTable } from "./_components/datasets-table";
import { DatasetsDetailPeek } from "./_components/datasets-detail-peek";

const WAVE_E2_DATASETS_LIST_COMPLETED = true as const;
void WAVE_E2_DATASETS_LIST_COMPLETED;

function DatasetsPageInner() {
  const d = useDatasetsPage();

  if (!d.currentOrg) return <NoOrgState feature="Datasets" />;

  const { load } = d;

  return (
    <div
      data-wave-e2-datasets="list"
      data-wave-e2-density={d.density}
    >
      <CoreResourcePage
        size="wide"
        header={
          d.embedded ? undefined : (
            <PageHeader
              eyebrow="Data"
              title="Datasets"
              subtitle="Spreadsheet edit, import wizard, snapshots, promote-from-trace."
              icon={Database}
              actions={
                <Button
                  onClick={load}
                  variant="outline"
                  size="sm"
                  className="h-8 max-md:min-h-11"
                  disabled={d.loading}
                  loading={d.loading}
                  aria-label="Refresh datasets"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Refresh
                </Button>
              }
            />
          )
        }
        toolbar={
          <div
            className="flex flex-col gap-space-3 sm:flex-row sm:flex-wrap sm:items-center"
            data-wave-e2-search="single"
            data-wave-e2-saved-views="datasets"
          >
            <DatasetsCreateStrip
              nameInputRef={d.nameInputRef}
              newName={d.newName}
              setNewName={d.setNewName}
              creating={d.creating}
              createDataset={d.createDataset}
            />
            <ResourceOsToolbar
              resourceKey="datasets"
              searchPlaceholder="Filter datasets"
              exportRows={d.filtered.map((row) => ({
                id: row.id,
                name: row.name,
                row_count: (row as { row_count?: number }).row_count ?? 0,
              }))}
              exportFilename="datasets.csv"
            />
          </div>
        }
        table={
          <QueryState
            loading={d.loading && d.datasets.length === 0}
            error={d.error ? new Error(d.error) : null}
            data={d.datasets}
            onRetry={load}
            errorTitle="Could not load datasets"
            isEmpty={() => d.filtered.length === 0}
            filtersActive={d.filterActive}
            emptyKind={d.filterMiss ? "filter-empty" : "zero-data"}
            filterEmptySlot={
              <EmptyState
                icon={Database}
                title="No matching datasets"
                description={`Nothing matches “${d.filter.trim()}”. Clear the filter or create a new dataset.`}
                variant="plain"
                action={
                  <Button
                    className="h-8 max-md:min-h-11"
                    variant="outline"
                    data-testid="datasets-clear-filter"
                    onClick={d.clearFilter}
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
                description="Create a dataset, add rows from Traces, or read the docs — then open Playground."
                variant="plain"
                action={
                  <div
                    className="flex flex-wrap items-center justify-center gap-2 text-sm"
                    data-wave-e1-empty="datasets"
                    data-testid="datasets-empty-ctas"
                  >
                    <Button
                      className="h-8 max-md:min-h-11"
                      data-testid="datasets-empty-create"
                      onClick={() => d.nameInputRef.current?.focus()}
                    >
                      <Plus className="h-3.5 w-3.5" /> Create dataset
                    </Button>
                    <Button asChild className="h-8 max-md:min-h-11" variant="outline">
                      <Link href="/traces">From traces</Link>
                    </Button>
                    <Button asChild className="h-8 max-md:min-h-11" variant="ghost">
                      <a href={DOCS_QUICKSTART_URL} target="_blank" rel="noopener noreferrer">
                        Docs <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                      </a>
                    </Button>
                  </div>
                }
              />
            }
          >
            {() => (
              <DatasetsTable
                loading={d.loading}
                rows={d.filtered}
                datasetId={d.datasetId}
                onSelect={d.selectDataset}
              />
            )}
          </QueryState>
        }
        detail={
          d.selected ? (
            <DatasetsDetailPeek
              selected={d.selected}
              onClose={d.clearSelection}
              onPrev={d.selectPrev}
              onNext={d.selectNext}
            />
          ) : null
        }
      />
    </div>
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
