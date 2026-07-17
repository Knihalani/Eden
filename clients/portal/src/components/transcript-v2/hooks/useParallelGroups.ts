/**
 * N13 — group overlapping tool spans into parallel swimlanes.
 * Spans A,B are parallel if A.start < B.end && B.start < A.end and same parent.
 */

import { useMemo } from "react";
import type { TranscriptRow } from "@/lib/observability/types";

export type ParallelLane = {
  tool_name: string;
  span_id: string;
  status: string;
  preview: string;
  start_ms: number;
  end_ms: number;
};

export type TranscriptBlock =
  | { type: "row"; row: TranscriptRow; step_index: number }
  | { type: "parallel_tools"; lanes: ParallelLane[]; step_index: number; rows: TranscriptRow[] };

function isToolRow(row: TranscriptRow): boolean {
  if (row.tool_calls && row.tool_calls.length > 0) return true;
  const t = (row.event_type ?? "").toLowerCase();
  return t.includes("tool") || row.name.toLowerCase().includes("tool");
}

function rowWindow(row: TranscriptRow, idx: number): { start: number; end: number } {
  const offset = (row as { start_offset_ms?: number }).start_offset_ms;
  const start = typeof offset === "number" ? offset : idx * 10;
  const end = start + Math.max(row.duration_ms || 1, 1);
  return { start, end };
}

function overlaps(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start < b.end && b.start < a.end;
}

export function groupParallelTools(rows: TranscriptRow[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let i = 0;
  let step = 0;

  while (i < rows.length) {
    const row = rows[i];
    if (!isToolRow(row)) {
      blocks.push({ type: "row", row, step_index: step++ });
      i += 1;
      continue;
    }

    const group: TranscriptRow[] = [row];
    const windows = [rowWindow(row, i)];
    let j = i + 1;
    while (j < rows.length && isToolRow(rows[j])) {
      const w = rowWindow(rows[j], j);
      const overlapsAny = windows.some((prev) => overlaps(prev, w));
      if (!overlapsAny) break;
      group.push(rows[j]);
      windows.push(w);
      j += 1;
    }

    if (group.length === 1) {
      blocks.push({ type: "row", row: group[0], step_index: step++ });
    } else {
      const lanes: ParallelLane[] = group.map((r, li) => {
        const w = windows[li];
        return {
          tool_name: r.tool_calls?.[0]?.name ?? r.name,
          span_id: r.span_id,
          status: r.outcome ?? "ok",
          preview: r.name,
          start_ms: w.start,
          end_ms: w.end,
        };
      });
      blocks.push({ type: "parallel_tools", lanes, step_index: step++, rows: group });
    }
    i = j;
  }

  return blocks;
}

export function useParallelGroups(rows: TranscriptRow[]): TranscriptBlock[] {
  return useMemo(() => groupParallelTools(rows), [rows]);
}
