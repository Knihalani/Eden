"use client";

import Link from "next/link";
import { StatusBadge } from "@/components/ui/status-badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export type ArtifactVersionRow = {
  id: string;
  title: string;
  kind?: string;
  version?: string | number;
  agentId?: string | null;
  planId?: string | null;
  status?: string;
  gate?: string;
  createdAt?: string | null;
};

export type ArtifactVersionTableProps = {
  rows: ArtifactVersionRow[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  className?: string;
};

export function ArtifactVersionTable({
  rows,
  selectedId,
  onSelect,
  className,
}: ArtifactVersionTableProps) {
  const columns: DataTableColumn<ArtifactVersionRow>[] = [
    {
      key: "title",
      header: "Artifact",
      cell: (row) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-[var(--text-primary)]">
            {row.title}
          </div>
          <div className="font-mono text-xs text-[var(--text-muted)]">
            {row.id}
            {row.version != null ? ` · v${row.version}` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "kind",
      header: "Kind",
      cell: (row) => row.kind ?? "—",
    },
    {
      key: "gate",
      header: "Gate",
      cell: (row) =>
        row.gate ? <StatusBadge status={row.gate} /> : <span>—</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (row) =>
        row.status ? <StatusBadge status={row.status} /> : <span>—</span>,
    },
    {
      key: "age",
      header: "Age",
      cell: (row) =>
        row.createdAt ? formatRelativeTime(row.createdAt) : "—",
    },
  ];

  return (
    <div className={cn(className)} data-testid="artifact-version-table">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        highlightRowId={selectedId}
        onRowClick={(row) => onSelect?.(row.id)}
      />
    </div>
  );
}

export function ArtifactRelatedLinks({
  planId,
  agentId,
}: {
  planId?: string | null;
  agentId?: string | null;
}) {
  return (
    <div className="flex flex-wrap gap-3 text-sm">
      {planId ? (
        <Link
          href={`/improve/plans/${encodeURIComponent(planId)}`}
          className="text-[var(--accent)] hover:underline"
        >
          Plan {planId}
        </Link>
      ) : null}
      {agentId ? (
        <Link
          href={`/improve?tab=artifacts&agentId=${encodeURIComponent(agentId)}`}
          className="text-[var(--accent)] hover:underline"
        >
          Agent artifacts
        </Link>
      ) : null}
    </div>
  );
}
