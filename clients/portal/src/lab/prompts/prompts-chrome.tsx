"use client";

import { StatusChip } from "@/components/ds/primitives";
import type {
  PromptDetailTab,
  PromptStatus,
} from "@/lab/fixtures/prompts";
import { statusLabel } from "@/lab/fixtures/prompts";
import { cn } from "@/lib/utils";

export function parsePromptStatusFilter(
  v: string | null,
): PromptStatus | "all" {
  if (
    v === "draft" ||
    v === "shadow" ||
    v === "live" ||
    v === "archived"
  ) {
    return v;
  }
  return "all";
}

export function parsePromptTab(v: string | null): PromptDetailTab {
  if (v === "versions" || v === "deploy" || v === "editor") return v;
  return "editor";
}

export function PromptStatusChip({ status }: { status: PromptStatus }) {
  const tone =
    status === "live"
      ? "ok"
      : status === "shadow"
        ? "live"
        : status === "draft"
          ? "neutral"
          : "neutral";
  return <StatusChip tone={tone}>{statusLabel(status)}</StatusChip>;
}

export function PromptTabNav({
  value,
  onChange,
}: {
  value: PromptDetailTab;
  onChange: (next: PromptDetailTab) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Prompt view"
      className="inline-flex rounded-[var(--radius)] p-0.5 shadow-[inset_0_0_0_1px_var(--line)]"
    >
      {(
        [
          ["editor", "Editor"],
          ["versions", "Versions"],
          ["deploy", "Deploy"],
        ] as const
      ).map(([id, label]) => {
        const selected = value === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
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
