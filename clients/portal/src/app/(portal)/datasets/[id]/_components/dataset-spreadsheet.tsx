"use client";

import Link from "next/link";
import { PanelRightOpen, Upload } from "lucide-react";
import type { DatasetRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VirtualizedList, useDensity } from "@/components/portal-os";
import { cellValue, type ColDef } from "./dataset-cells";

export function DatasetSpreadsheet({
  rows,
  columns,
  loading,
  canMutate,
  selectedRowId,
  editing,
  editValue,
  onSelectRow,
  onStartEdit,
  onEditValueChange,
  onSaveCell,
  onCancelEdit,
  onImportClick,
}: {
  rows: DatasetRow[];
  columns: ColDef[];
  loading: boolean;
  canMutate: boolean;
  selectedRowId: string | undefined;
  editing: { rowId: string; key: string } | null;
  editValue: string;
  onSelectRow: (id: string | undefined) => void;
  onStartEdit: (rowId: string, key: string, value: string) => void;
  onEditValueChange: (value: string) => void;
  onSaveCell: (row: DatasetRow, key: string, value: string) => void;
  onCancelEdit: () => void;
  onImportClick: () => void;
}) {
  const density = useDensity();

  return (
    <div
      className="min-w-0 flex-1 overflow-x-auto border-y border-[var(--border-subtle)] py-space-2"
      data-wave-e2-spreadsheet="grid"
      data-wave-e2-density={density}
    >
      <div className="mb-2 flex items-center justify-between gap-2 px-2 text-xs text-[var(--text-muted)]">
        <span>
          {rows.length.toLocaleString()} rows
          {rows.length > 40 ? " · virtualized" : ""}
        </span>
        <div className="hidden min-w-0 flex-1 gap-2 overflow-hidden sm:flex">
          {columns.map((c) => (
            <span key={c.key} className="truncate font-medium">
              {c.label}
            </span>
          ))}
        </div>
      </div>
      {rows.length > 0 ? (
        <VirtualizedList items={rows} rowKey={(r) => r.id} className="min-w-[480px]">
          {(r) => (
            <div
              className={`flex items-stretch gap-1 border-b border-[var(--border-subtle)] px-1 py-1 text-sm ${
                selectedRowId === r.id ? "bg-[var(--bg-tertiary)]" : ""
              }`}
            >
              <button
                type="button"
                className="w-8 shrink-0 inline-flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--accent)]"
                aria-label={`Peek row ${r.id}`}
                onClick={() => onSelectRow(selectedRowId === r.id ? undefined : r.id)}
              >
                <PanelRightOpen className="h-3.5 w-3.5" aria-hidden />
              </button>
              {columns.map((c) => {
                const isEdit = editing?.rowId === r.id && editing.key === c.key;
                const val = cellValue(r, c.key);
                return (
                  <div key={c.key} className="min-w-0 flex-1 p-1">
                    {isEdit ? (
                      <Input
                        autoFocus
                        className="h-8 font-mono text-xs"
                        value={editValue}
                        onChange={(e) => onEditValueChange(e.target.value)}
                        onBlur={() => void onSaveCell(r, c.key, editValue)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void onSaveCell(r, c.key, editValue);
                          if (e.key === "Escape") onCancelEdit();
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="w-full truncate rounded px-1 py-1 text-left font-mono text-xs hover:bg-[var(--surface-raised)]"
                        onClick={() => onStartEdit(r.id, c.key, val)}
                      >
                        {val || "—"}
                      </button>
                    )}
                  </div>
                );
              })}
              <div className="w-28 shrink-0 p-2 text-xs text-[var(--text-muted)]">
                {r.created_at ? new Date(r.created_at).toLocaleString() : "—"}
              </div>
            </div>
          )}
        </VirtualizedList>
      ) : null}
      {!loading && rows.length === 0 ? (
        <div className="space-y-3 p-4 text-sm text-[var(--text-muted)]">
          <p>No rows yet. Import CSV/JSONL or add a row above.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={!canMutate} onClick={onImportClick}>
              <Upload className="h-3.5 w-3.5" /> Import file
            </Button>
            <Button asChild size="sm" variant="ghost">
              <Link href="/evals?tab=labeling">Labeling → push to dataset</Link>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
