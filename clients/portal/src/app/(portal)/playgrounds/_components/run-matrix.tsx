"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  isFailingOrRegressedRow,
  sortMatrixFailingFirst,
  type RunMatrix,
} from "./run-matrix-types";

export const WAVE_E3_MATRIX_COMPLETED = true;

export function RunMatrixResults({
  run,
}: {
  run: RunMatrix;
}) {
  const rows = sortMatrixFailingFirst(run.matrix ?? []);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (rows.length === 0) {
      setFocusedIndex(0);
      return;
    }
    setFocusedIndex((prev) => Math.min(Math.max(prev, 0), rows.length - 1));
  }, [rows.length]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "j" && e.key !== "k") return;
      if (rows.length === 0) return;

      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) {
        return;
      }
      const inMatrix =
        target === el || (target != null && el.contains(target));
      if (!inMatrix) return;

      e.preventDefault();
      setFocusedIndex((prev) => {
        const next =
          e.key === "j"
            ? Math.min(prev + 1, rows.length - 1)
            : Math.max(prev - 1, 0);
        requestAnimationFrame(() => {
          const row = el.querySelector<HTMLElement>(
            `[data-wave-e3-matrix-row][data-testid="playground-matrix-row-${rows[next]?.row_id}"]`,
          );
          row?.focus();
        });
        return next;
      });
    };

    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, [rows]);

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      data-wave-e3-matrix="results"
      data-testid="playground-run-matrix"
      data-wave-e3-matrix-focus={focusedIndex}
      aria-label="Run matrix results. Press j and k to move between rows."
      className="space-y-space-3 border-t border-[var(--border-subtle)] pt-space-4 outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-default)]"
    >
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">Matrix results</span>
        <span className="text-[var(--text-muted)]">
          cost_usd ${Number(run.cost_usd ?? 0).toFixed(4)}
        </span>
      </div>
      {rows.map((row, index) => {
        const failing = isFailingOrRegressedRow(row);
        const focused = index === focusedIndex;
        return (
          <div
            key={row.row_id}
            data-wave-e3-matrix-row=""
            data-testid={`playground-matrix-row-${row.row_id}`}
            data-failing={failing ? "true" : "false"}
            tabIndex={focused ? 0 : undefined}
            className={cn(
              "rounded border border-[var(--border-default)] p-space-3",
              failing && "text-[var(--error)]",
              focused && "border-[var(--accent)] bg-[var(--bg-tertiary)]/40",
            )}
          >
            <div
              className={cn(
                "mb-2 flex gap-3 text-xs",
                failing ? "text-[var(--error)]" : "text-[var(--text-muted)]",
              )}
            >
              <span>grade: {row.grade}</span>
              <span>Δ {Number(row.score_delta ?? 0).toFixed(3)}</span>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {(row.tasks || []).map((t, i) => (
                <div key={i} className="rounded bg-[var(--surface-raised)] p-2">
                  <div
                    className={cn(
                      "mb-1 text-xs font-medium",
                      failing ? "text-[var(--error)]" : "text-[var(--text-primary)]",
                    )}
                  >
                    {t.label || t.model} · ${Number(t.cost_usd ?? 0).toFixed(4)}
                  </div>
                  <pre
                    className={cn(
                      "whitespace-pre-wrap text-xs",
                      failing ? "text-[var(--error)]" : "text-[var(--text-secondary)]",
                    )}
                  >
                    {t.response}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
