"use client";

import { StatusChip } from "@/components/ds/primitives";
import type {
  AbLayout,
  AbPrimaryMetric,
  AbRecommendation,
  AbSampleGrade,
  AbStatus,
} from "@/lab/fixtures/compare";
import {
  layoutLabel,
  layoutSubtitle,
  verdictLabel,
} from "@/lab/fixtures/compare";
import { cn } from "@/lib/utils";

export function parseAbLayout(v: string | null): AbLayout {
  if (v === "overview" || v === "samples" || v === "timeline") return v;
  return "overview";
}

export function parseAbMetric(v: string | null): AbPrimaryMetric {
  if (v === "stumble" || v === "score" || v === "cost" || v === "latency") {
    return v;
  }
  return "stumble";
}

export function parseAbGrade(v: string | null): AbSampleGrade | "all" {
  if (
    v === "improve" ||
    v === "regress" ||
    v === "tradeoff" ||
    v === "tie"
  ) {
    return v;
  }
  return "all";
}

export function parseAbStatusFilter(
  v: string | null,
): AbStatus | "all" {
  if (v === "active" || v === "stopped" || v === "winner_detected") return v;
  return "all";
}

export function AbRecChip({ rec }: { rec: AbRecommendation }) {
  const tone =
    rec === "ship" || rec === "ship_with_monitoring"
      ? "ok"
      : rec === "dont_ship"
        ? "fail"
        : "neutral";
  return <StatusChip tone={tone}>{verdictLabel(rec)}</StatusChip>;
}

/** Segmented Decision / Examples / Trend — Debugger-style, with tooltips. */
export function AbLayoutNav({
  value,
  onChange,
}: {
  value: AbLayout;
  onChange: (next: AbLayout) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="How to review this experiment"
      className="inline-flex rounded-[var(--radius)] p-0.5 shadow-[inset_0_0_0_1px_var(--line)]"
    >
      {(
        [
          ["overview", "Decision"],
          ["samples", "Examples"],
          ["timeline", "Trend"],
        ] as const
      ).map(([id, label]) => {
        const selected = value === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            title={layoutSubtitle(id)}
            aria-selected={selected}
            className={cn(
              "type-meta rounded-[calc(var(--radius)-2px)] px-3 py-1.5 transition-colors",
              selected
                ? "bg-[var(--accent-muted)] text-[var(--text)] shadow-[inset_0_0_0_1px_var(--accent)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]",
            )}
            onClick={() => onChange(id)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function layoutTabLabel(layout: AbLayout): string {
  return layoutLabel(layout);
}
