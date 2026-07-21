"use client";

import type { DatasetDetail } from "./dataset-cells";

export function DatasetSnapshots({
  snapshots,
}: {
  snapshots: NonNullable<DatasetDetail["snapshots"]>;
}) {
  if (snapshots.length === 0) return null;
  return (
    <div className="mb-space-3 border-y border-[var(--border-subtle)] py-space-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
        Snapshots
      </div>
      <ul className="flex flex-wrap gap-2 text-xs">
        {snapshots.map((s) => (
          <li
            key={s.id}
            className="rounded border border-[var(--border-default)] px-2 py-1"
          >
            v{s.version} · {s.row_count} rows ·{" "}
            {s.created_at ? new Date(s.created_at).toLocaleString() : "—"}
          </li>
        ))}
      </ul>
    </div>
  );
}
