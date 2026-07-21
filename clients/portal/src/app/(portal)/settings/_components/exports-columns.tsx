"use client";

import { Loader2, Trash2, Play } from "lucide-react";
import type { DataTableColumn } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";

type Destination = {
  destination_id: string;
  name: string;
  type: string;
  config?: { bucket?: string } | null;
  created_at?: string | null;
};

type Schedule = {
  schedule_id: string;
  destination_id: string | null;
  data_type: string;
  format: string;
  cron_expression?: string | null;
  last_run_at?: string | null;
};

export function buildExportDestColumns(opts: {
  orgId: string;
  onDelete: (d: Destination) => void;
}): DataTableColumn<Destination>[] {
  return [
    {
      key: "name",
      header: "Name",
      sortable: true,
      cell: (d) => <span className="text-sm font-medium">{d.name}</span>,
    },
    {
      key: "type",
      header: "Type",
      cell: (d) => (
        <span className="text-xs uppercase text-[var(--text-secondary)]">{d.type}</span>
      ),
    },
    {
      key: "bucket",
      header: "Bucket",
      cell: (d) => (
        <span className="text-sm font-mono text-[var(--text-muted)]">
          {String(d.config?.bucket || "—")}
        </span>
      ),
    },
    {
      key: "created_at",
      header: "Created",
      sortable: true,
      cell: (d) => (
        <span className="text-xs text-[var(--text-muted)]">
          {d.created_at ? new Date(d.created_at).toLocaleString() : "—"}
        </span>
      ),
    },
    {
      key: "destination_id",
      header: "",
      align: "right",
      cell: (d) => (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => opts.onDelete(d)}
          className="text-[var(--error)] hover:bg-[var(--error-bg)]"
          aria-label={`Delete destination ${d.name}`}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      ),
    },
  ];
}

export function buildExportSchedColumns(opts: {
  destinations: Destination[];
  running: string | null;
  onRun: (id: string) => void;
  onDelete: (s: Schedule) => void;
}): DataTableColumn<Schedule>[] {
  return [
    {
      key: "data_type",
      header: "Data",
      cell: (s) => {
        const dest = opts.destinations.find((d) => d.destination_id === s.destination_id);
        return (
          <>
            <span className="text-xs mr-1 text-[var(--text-primary)]">{s.data_type}</span>
            <span className="text-xs text-[var(--text-muted)]">
              → {dest?.name || "download"}
            </span>
          </>
        );
      },
    },
    {
      key: "format",
      header: "Format",
      cell: (s) => (
        <span className="text-sm text-[var(--text-secondary)] uppercase">{s.format}</span>
      ),
    },
    {
      key: "cron_expression",
      header: "Schedule",
      cell: (s) => (
        <span className="text-sm font-mono text-[var(--text-muted)]">
          {s.cron_expression || "one-shot"}
        </span>
      ),
    },
    {
      key: "last_run_at",
      header: "Last run",
      sortable: true,
      cell: (s) => (
        <span className="text-xs text-[var(--text-muted)]">
          {s.last_run_at ? new Date(s.last_run_at).toLocaleString() : "—"}
        </span>
      ),
    },
    {
      key: "schedule_id",
      header: "",
      align: "right",
      cell: (s) => (
        <div className="flex justify-end gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => opts.onRun(s.schedule_id)}
            disabled={opts.running === s.schedule_id}
            aria-label="Run now"
          >
            {opts.running === s.schedule_id ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => opts.onDelete(s)}
            className="text-[var(--error)] hover:bg-[var(--error-bg)]"
            aria-label="Delete schedule"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      ),
    },
  ];
}
