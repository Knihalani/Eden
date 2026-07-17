"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadCsv, downloadJsonl } from "@/lib/export";
import { cn } from "@/lib/utils";

export interface TableExportToolbarProps<T extends Record<string, unknown>> {
  rows: T[];
  filename: string;
  columns?: Array<keyof T>;
  className?: string;
  disabled?: boolean;
}

/**
 * CSV / JSONL export toolbar for resource hub tables.
 */
export function TableExportToolbar<T extends Record<string, unknown>>({
  rows,
  filename,
  columns,
  className,
  disabled,
}: TableExportToolbarProps<T>) {
  const empty = rows.length === 0 || disabled;
  return (
    <div className={cn("inline-flex items-center gap-1", className)} role="group" aria-label="Export table">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={empty}
        onClick={() => downloadCsv(filename, rows, columns)}
        aria-label="Export CSV"
      >
        <Download className="h-3.5 w-3.5" aria-hidden />
        CSV
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={empty}
        onClick={() => downloadJsonl(`${filename.replace(/\.csv$/i, "")}.jsonl`, rows)}
        aria-label="Export JSONL"
      >
        JSONL
      </Button>
    </div>
  );
}
