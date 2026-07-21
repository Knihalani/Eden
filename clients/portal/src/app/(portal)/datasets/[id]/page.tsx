"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import {
  ArrowLeft,
  Database,
  RefreshCw,
  Plus,
  Camera,
  Upload,
  FlaskConical,
  ChevronDown,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDatasetDetail } from "./_components/use-dataset-detail";
import { DatasetImportInput, DatasetImportProgress } from "./_components/dataset-import-panel";
import { DatasetSnapshots } from "./_components/dataset-snapshots";
import { DatasetSpreadsheet } from "./_components/dataset-spreadsheet";
import { DatasetRowPeek } from "./_components/dataset-row-peek";

const WAVE_E2_DATASETS_DETAIL_COMPLETED = true as const;

export default function DatasetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const d = useDatasetDetail(id);

  if (!d.currentOrg) return <NoOrgState feature="Dataset" />;

  void WAVE_E2_DATASETS_DETAIL_COMPLETED;

  return (
    <div data-wave-e2-datasets="detail">
      <PageContent size="wide">
        <PageHeader
          eyebrow="Data · Dataset"
          title={d.data?.name || (d.error ? "Dataset" : d.loading ? "Loading…" : "Dataset")}
          subtitle={
            d.error
              ? "Load failed — retry below."
              : d.data?.description ||
                (d.loading ? "Loading…" : "Spreadsheet edit · import · snapshots.")
          }
          icon={Database}
          actions={
            <>
              <Link
                href="/evals?tab=datasets"
                aria-label="Back to datasets list"
                className="inline-flex h-8 max-md:min-h-11 items-center gap-1 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </Link>
              <Button
                onClick={() => void d.startExperiment()}
                className="h-8 max-md:min-h-11"
                disabled={!d.canMutate}
                data-wave-e2-start-experiment="primary"
                data-testid="dataset-start-experiment"
              >
                <FlaskConical className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Start experiment</span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    className="h-8 max-md:min-h-11"
                    aria-label="More dataset actions"
                  >
                    More
                    <ChevronDown className="h-4 w-4" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={!d.canMutate} onSelect={() => void d.snapshot()}>
                    <Camera className="h-3.5 w-3.5" /> Snapshot
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!d.canMutate}
                    onSelect={() => d.fileRef.current?.click()}
                  >
                    <Upload className="h-3.5 w-3.5" /> Import
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={d.loading} onSelect={() => void d.load()}>
                    <RefreshCw className="h-3.5 w-3.5" /> Refresh
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <DatasetImportInput fileRef={d.fileRef} onImportFile={d.onImportFile} />
            </>
          }
        />

        <DatasetImportProgress progress={d.importProgress} />

        {d.error && !d.loading ? (
          <ErrorState
            title="Could not load dataset"
            message={d.error}
            action={
              <Button
                onClick={d.load}
                variant="outline"
                size="sm"
                disabled={d.loading}
                loading={d.loading}
              >
                Try again
              </Button>
            }
          />
        ) : null}

        {!d.error ? (
          <>
            {(d.data?.snapshots?.length ?? 0) > 0 ? (
              <DatasetSnapshots snapshots={d.data!.snapshots!} />
            ) : null}

            <div className="mb-space-3 space-y-space-3 border-y border-[var(--border-subtle)] py-space-4">
              <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                Add row
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  placeholder='{"input": "…", "expected_output": "…"}'
                  value={d.newRow}
                  onChange={(e) => d.setNewRow(e.target.value)}
                  className="flex-1 font-mono text-xs"
                  disabled={d.submitting || d.loading}
                />
                <Button
                  onClick={() => void d.addRow()}
                  disabled={!d.newRow.trim() || d.submitting || d.loading}
                  loading={d.submitting}
                >
                  <Plus className="h-3.5 w-3.5" /> Add
                </Button>
              </div>
              <p className="text-xs text-[var(--text-muted)]">
                Click any cell to edit inline. Promote traces from the traces hub with{" "}
                <code className="text-[var(--accent)]">?promote_trace=</code>.
              </p>
            </div>

            <div className="flex flex-col xl:flex-row xl:items-start gap-space-4">
              <DatasetSpreadsheet
                rows={d.data?.rows ?? []}
                columns={d.columns}
                loading={d.loading}
                canMutate={d.canMutate}
                selectedRowId={d.selectedRowId}
                editing={d.editing}
                editValue={d.editValue}
                onSelectRow={d.setSelectedRowId}
                onStartEdit={(rowId, key, value) => {
                  d.setEditing({ rowId, key });
                  d.setEditValue(value);
                }}
                onEditValueChange={d.setEditValue}
                onSaveCell={d.saveCell}
                onCancelEdit={() => d.setEditing(null)}
                onImportClick={() => d.fileRef.current?.click()}
              />
              {d.selectedRow ? (
                <DatasetRowPeek
                  row={d.selectedRow}
                  columns={d.columns}
                  onClose={() => d.setSelectedRowId(undefined)}
                />
              ) : null}
            </div>
          </>
        ) : null}
      </PageContent>
    </div>
  );
}
