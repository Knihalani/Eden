"use client";

import Link from "next/link";
import { InfiniteDataTable } from "@/components/portal-os";
import { Database, ExternalLink } from "lucide-react";
import type { Dataset } from "@/lib/api";

export function DatasetsTable({
  loading,
  rows,
  datasetId,
  onSelect,
}: {
  loading: boolean;
  rows: Dataset[];
  datasetId: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <div
      className="min-w-0 border-y border-[var(--border-subtle)] py-space-2"
      data-wave11-mobile="cards"
      data-wave-e6-keyboard="datasets"
    >
      <InfiniteDataTable
        loading={loading}
        rows={rows}
        rowKey={(r) => r.id}
        emptyTitle="No datasets"
        emptyDescription="No datasets yet."
        emptyIcon={Database}
        onRowClick={(r) => onSelect(r.id)}
        highlightRowId={datasetId}
        columns={[
          {
            key: "name",
            header: "Name",
            sortable: true,
            cell: (r) => (
              <button
                type="button"
                className="font-medium text-[var(--accent)] hover:underline"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(r.id);
                }}
              >
                {r.name}
              </button>
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
                aria-label={`Open spreadsheet for ${r.name}`}
                className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                onClick={(e) => e.stopPropagation()}
              >
                Edit <ExternalLink className="h-3 w-3" />
              </Link>
            ),
          },
        ]}
      />
    </div>
  );
}
