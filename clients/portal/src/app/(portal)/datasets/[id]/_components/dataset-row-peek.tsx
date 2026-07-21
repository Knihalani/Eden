"use client";

import type { DatasetRow } from "@/lib/api";
import { DetailPanelShell } from "@/components/portal-os";
import { cellValue, type ColDef } from "./dataset-cells";

export function DatasetRowPeek({
  row,
  columns,
  onClose,
}: {
  row: DatasetRow;
  columns: ColDef[];
  onClose: () => void;
}) {
  return (
    <DetailPanelShell
      open
      onClose={onClose}
      title={<span className="font-mono text-xs">Row {row.id.slice(0, 8)}…</span>}
      widthClassName="xl:w-[min(420px,40vw)]"
    >
      <dl className="space-y-3 p-4 text-xs">
        {columns.map((c) => (
          <div key={c.key} className="space-y-1">
            <dt className="text-[var(--text-muted)] font-medium">{c.label}</dt>
            <dd className="font-mono break-all text-[var(--text-primary)] whitespace-pre-wrap">
              {cellValue(row, c.key) || "—"}
            </dd>
          </div>
        ))}
      </dl>
    </DetailPanelShell>
  );
}
