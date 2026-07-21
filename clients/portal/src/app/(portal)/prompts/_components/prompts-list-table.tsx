"use client";

import { Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";

export interface PromptListRow {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  auto_eval_on_save: boolean;
  created_at: string;
}

export function PromptsListTable({
  prompts,
  selectedName,
  onSelect,
  onCreate,
}: {
  prompts: PromptListRow[];
  selectedName: string | null;
  onSelect: (name: string) => void;
  onCreate: () => void;
}) {
  const columns: DataTableColumn<PromptListRow>[] = [
    {
      key: "name",
      header: "Name",
      sortable: true,
      cell: (r) => (
        <span className="font-medium text-[var(--text-primary)]">{r.name}</span>
      ),
    },
    {
      key: "description",
      header: "Description",
      cell: (r) => (
        <span className="text-[var(--text-muted)] truncate max-w-[14rem] block">
          {r.description || "—"}
        </span>
      ),
    },
    {
      key: "auto_eval_on_save",
      header: "Auto-eval",
      cell: (r) =>
        r.auto_eval_on_save ? (
          <Badge variant="outline" className="text-[length:var(--font-size-2xs)] uppercase">
            on
          </Badge>
        ) : (
          <span className="text-[var(--text-muted)]">—</span>
        ),
    },
    {
      key: "created_at",
      header: "Created",
      sortable: true,
      align: "right",
      cell: (r) => (
        <span className="text-[var(--text-muted)] tabular-nums">
          {new Date(r.created_at).toLocaleDateString()}
        </span>
      ),
    },
  ];

  return (
    <div data-testid="prompts-version-list">
      <DataTable
        columns={columns}
        rows={prompts}
        rowKey={(r) => r.id}
        highlightRowId={
          selectedName
            ? prompts.find((p) => p.name === selectedName)?.id
            : undefined
        }
        onRowClick={(r) => onSelect(r.name)}
        emptyTitle="No prompts yet"
        emptyDescription="Create your first prompt to start the version timeline."
        emptyAction={
          <Button size="sm" onClick={onCreate}>
            <Plus className="h-4 w-4" />
            New prompt
          </Button>
        }
        pageSize={50}
        className="border border-[var(--border-subtle)] rounded-xl overflow-hidden"
      />
    </div>
  );
}
